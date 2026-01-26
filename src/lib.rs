use heed::{types::*, Database, Env, EnvOpenOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// Matrix entry value stored as JSON
#[derive(Serialize, Deserialize, Clone, Debug)]
struct MatrixValue {
    order: f64,
    verb_value: Option<String>,
}

#[napi]
pub struct ComposiaEngine {
    pub(crate) env: Env,
    pub(crate) units: Database<Str, Str>,
    pub(crate) matrix: Database<Str, Str>,
    pub(crate) namespaces: Database<Str, Str>,
}

#[napi]
impl ComposiaEngine {
    #[napi(constructor)]
    pub fn new(db_path: String) -> Result<Self> {
        let path = Path::new(&db_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::from_reason(e.to_string()))?;
        }

        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(10 * 1024 * 1024 * 1024) // 10GB
                .max_dbs(3) // units, matrix, namespaces
                .open(path)
                .map_err(|e| Error::from_reason(e.to_string()))?
        };

        let mut w_txn = env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let units = env
            .create_database(&mut w_txn, Some("units"))
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let matrix = env
            .create_database(&mut w_txn, Some("matrix"))
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let namespaces = env
            .create_database(&mut w_txn, Some("namespaces"))
            .map_err(|e| Error::from_reason(e.to_string()))?;

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(Self {
            env,
            units,
            matrix,
            namespaces,
        })
    }

    // ==================== NAMESPACE OPERATIONS ====================

    /// Register a new namespace (fails if already exists)
    #[napi(js_name = "register_namespace")]
    pub fn register_namespace(&self, namespace_id: String, metadata: Value) -> Result<()> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        // Check if namespace already exists
        if self
            .namespaces
            .get(&w_txn, &namespace_id)
            .map_err(|e| Error::from_reason(e.to_string()))?
            .is_some()
        {
            return Err(Error::from_reason(format!(
                "Namespace '{}' already exists",
                namespace_id
            )));
        }

        let serialized =
            serde_json::to_string(&metadata).map_err(|e| Error::from_reason(e.to_string()))?;

        self.namespaces
            .put(&mut w_txn, &namespace_id, &serialized)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(())
    }

    /// Check if a namespace exists
    #[napi(js_name = "namespace_exists")]
    pub fn namespace_exists(&self, namespace_id: String) -> Result<bool> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let exists = self
            .namespaces
            .get(&r_txn, &namespace_id)
            .map_err(|e| Error::from_reason(e.to_string()))?
            .is_some();

        Ok(exists)
    }

    /// Get namespace metadata
    #[napi(js_name = "get_namespace")]
    pub fn get_namespace(&self, namespace_id: String) -> Result<Option<Value>> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        match self
            .namespaces
            .get(&r_txn, &namespace_id)
            .map_err(|e| Error::from_reason(e.to_string()))?
        {
            Some(s) => {
                let metadata: Value =
                    serde_json::from_str(s).map_err(|e| Error::from_reason(e.to_string()))?;
                Ok(Some(metadata))
            }
            None => Ok(None),
        }
    }

    /// List all namespaces
    #[napi(js_name = "list_namespaces")]
    pub fn list_namespaces(&self) -> Result<Vec<Value>> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut results = Vec::new();
        let iter = self
            .namespaces
            .iter(&r_txn)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        for item in iter {
            let (key, value) = item.map_err(|e| Error::from_reason(e.to_string()))?;
            let metadata: Value =
                serde_json::from_str(value).map_err(|e| Error::from_reason(e.to_string()))?;
            results.push(serde_json::json!({
                "id": key,
                "metadata": metadata
            }));
        }

        Ok(results)
    }

    /// Delete a namespace
    #[napi(js_name = "delete_namespace")]
    pub fn delete_namespace(&self, namespace_id: String) -> Result<bool> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let deleted = self
            .namespaces
            .delete(&mut w_txn, &namespace_id)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(deleted)
    }

    // ==================== UNIT OPERATIONS ====================

    /// Batch insert/update units
    #[napi(js_name = "put_units")]
    pub fn put_units(&self, units: Vec<Value>) -> Result<Vec<Value>> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut results = Vec::new();
        for unit in units {
            let id = unit["id"]
                .as_str()
                .ok_or_else(|| Error::from_reason("Missing 'id' field in unit"))?;

            let serialized =
                serde_json::to_string(&unit).map_err(|e| Error::from_reason(e.to_string()))?;

            self.units
                .put(&mut w_txn, id, &serialized)
                .map_err(|e| Error::from_reason(e.to_string()))?;

            results.push(unit);
        }

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(results)
    }

    /// Batch fetch units by IDs
    #[napi(js_name = "get_units")]
    pub fn get_units(&self, ids: Vec<String>) -> Result<Vec<Value>> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut results = Vec::new();
        for id in ids {
            if let Some(s) = self
                .units
                .get(&r_txn, &id)
                .map_err(|e| Error::from_reason(e.to_string()))?
            {
                let unit: Value =
                    serde_json::from_str(s).map_err(|e| Error::from_reason(e.to_string()))?;
                results.push(unit);
            }
        }

        Ok(results)
    }

    /// Update units (partial update - merges with existing)
    #[napi(js_name = "update_units")]
    pub fn update_units(&self, updates: Vec<Value>) -> Result<Vec<Value>> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut results = Vec::new();
        for update in updates {
            let id = update["id"]
                .as_str()
                .ok_or_else(|| Error::from_reason("Missing 'id' field in update"))?;

            // Fetch existing unit
            let existing = self
                .units
                .get(&w_txn, id)
                .map_err(|e| Error::from_reason(e.to_string()))?
                .ok_or_else(|| Error::from_reason(format!("Unit '{}' not found", id)))?;

            let mut unit: Value =
                serde_json::from_str(existing).map_err(|e| Error::from_reason(e.to_string()))?;

            // Merge update fields (shallow merge at top level)
            if let (Some(obj), Some(upd)) = (unit.as_object_mut(), update.as_object()) {
                for (key, value) in upd {
                    if key != "id" {
                        // Don't allow changing ID
                        obj.insert(key.clone(), value.clone());
                    }
                }
            }

            let serialized =
                serde_json::to_string(&unit).map_err(|e| Error::from_reason(e.to_string()))?;

            self.units
                .put(&mut w_txn, id, &serialized)
                .map_err(|e| Error::from_reason(e.to_string()))?;

            results.push(unit);
        }

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(results)
    }

    /// Delete units by IDs
    #[napi(js_name = "delete_units")]
    pub fn delete_units(&self, ids: Vec<String>) -> Result<Vec<String>> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut deleted = Vec::new();
        for id in ids {
            if self
                .units
                .delete(&mut w_txn, &id)
                .map_err(|e| Error::from_reason(e.to_string()))?
            {
                deleted.push(id);
            }
        }

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(deleted)
    }

    // ==================== MATRIX OPERATIONS ====================

    /// Create a matrix entry (instruction)
    /// Key format: namespace:source:verb:target:order (order padded for lexicographic sort)
    /// Value format: {order, verb_value}
    #[napi(js_name = "link_units")]
    pub fn link_units(
        &self,
        namespace: String,
        source: String,
        verb: String,
        target: String,
        order: f64,
        verb_value: Option<String>,
    ) -> Result<()> {
        // Validate namespace exists
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        if self
            .namespaces
            .get(&r_txn, &namespace)
            .map_err(|e| Error::from_reason(e.to_string()))?
            .is_none()
        {
            return Err(Error::from_reason(format!(
                "Namespace '{}' not registered",
                namespace
            )));
        }
        drop(r_txn);

        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        // Include order in key (padded to 10 digits) to allow multiple entries per target
        let key = format!("{}:{}:{}:{}:{:010.0}", namespace, source, verb, target, order);
        let value = MatrixValue { order, verb_value };
        let serialized =
            serde_json::to_string(&value).map_err(|e| Error::from_reason(e.to_string()))?;

        self.matrix
            .put(&mut w_txn, &key, &serialized)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(())
    }

    /// Delete all matrix entries for a namespace:source:verb:target combination
    #[napi(js_name = "unlink_units")]
    pub fn unlink_units(
        &self,
        namespace: String,
        source: String,
        verb: String,
        target: String,
    ) -> Result<bool> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        // Prefix to match all entries for this target (regardless of order)
        let prefix = format!("{}:{}:{}:{}:", namespace, source, verb, target);
        let mut deleted_any = false;

        // Collect keys to delete (can't delete while iterating)
        let keys_to_delete: Vec<String> = {
            let iter = self
                .matrix
                .prefix_iter(&w_txn, &prefix)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            iter.filter_map(|item| item.ok().map(|(k, _)| k.to_string()))
                .collect()
        };

        for key in keys_to_delete {
            if self
                .matrix
                .delete(&mut w_txn, &key)
                .map_err(|e| Error::from_reason(e.to_string()))?
            {
                deleted_any = true;
            }
        }

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(deleted_any)
    }

    /// Check if a matrix entry exists (any entry for this target)
    #[napi(js_name = "has_matrix_entry")]
    pub fn has_matrix_entry(
        &self,
        namespace: String,
        source: String,
        verb: String,
        target: String,
    ) -> Result<bool> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        // Use prefix search since keys now include order suffix
        let prefix = format!("{}:{}:{}:{}:", namespace, source, verb, target);
        let mut iter = self
            .matrix
            .prefix_iter(&r_txn, &prefix)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        // Check if there's at least one entry
        Ok(iter.next().is_some())
    }

    /// Get a single matrix entry (returns first match if multiple exist)
    #[napi(js_name = "get_matrix_entry")]
    pub fn get_matrix_entry(
        &self,
        namespace: String,
        source: String,
        verb: String,
        target: String,
    ) -> Result<Option<Value>> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        // Use prefix search since keys now include order suffix
        let prefix = format!("{}:{}:{}:{}:", namespace, source, verb, target);
        let mut iter = self
            .matrix
            .prefix_iter(&r_txn, &prefix)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        match iter.next() {
            Some(result) => {
                let (_, value_str) = result.map_err(|e| Error::from_reason(e.to_string()))?;
                let value: MatrixValue =
                    serde_json::from_str(value_str).map_err(|e| Error::from_reason(e.to_string()))?;
                Ok(Some(serde_json::json!({
                    "order": value.order,
                    "verb_value": value.verb_value
                })))
            }
            None => Ok(None),
        }
    }

    /// Get all targets for a namespace:source:verb prefix
    /// Key format: namespace:source:verb:target:order
    /// Returns sorted by order
    #[napi(js_name = "get_targets")]
    pub fn get_targets(
        &self,
        namespace: String,
        source: String,
        verb: String,
    ) -> Result<Vec<Value>> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let prefix = format!("{}:{}:{}:", namespace, source, verb);
        let mut results = Vec::new();

        let iter = self
            .matrix
            .prefix_iter(&r_txn, &prefix)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        for item in iter {
            let (key, value_str) = item.map_err(|e| Error::from_reason(e.to_string()))?;
            // Key format: namespace:source:verb:target:order
            // Target is at index 3 (4th part)
            let parts: Vec<&str> = key.split(':').collect();
            let target_id = parts.get(3).unwrap_or(&"").to_string();

            let value: MatrixValue =
                serde_json::from_str(value_str).map_err(|e| Error::from_reason(e.to_string()))?;

            results.push(serde_json::json!({
                "target": target_id,
                "order": value.order,
                "verb_value": value.verb_value
            }));
        }

        // Sort by order
        results.sort_by(|a, b| {
            a["order"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&b["order"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(results)
    }

    /// Get matrix entries by prefix (for debugging/admin)
    /// Key format: namespace:source:verb:target:order
    #[napi(js_name = "get_matrix_segment")]
    pub fn get_matrix_segment(&self, prefix: String) -> Result<Vec<Value>> {
        let r_txn = self
            .env
            .read_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        let mut results = Vec::new();

        let iter = self
            .matrix
            .prefix_iter(&r_txn, &prefix)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        for item in iter {
            let (key, value_str) = item.map_err(|e| Error::from_reason(e.to_string()))?;
            let parts: Vec<&str> = key.split(':').collect();

            let value: MatrixValue =
                serde_json::from_str(value_str).map_err(|e| Error::from_reason(e.to_string()))?;

            results.push(serde_json::json!({
                "namespace": parts.get(0).unwrap_or(&""),
                "source": parts.get(1).unwrap_or(&""),
                "verb": parts.get(2).unwrap_or(&""),
                "target": parts.get(3).unwrap_or(&""),
                "order": value.order,
                "verb_value": value.verb_value
            }));
        }

        Ok(results)
    }

    // ==================== DATABASE OPERATIONS ====================

    /// Clear all databases (for testing)
    #[napi(js_name = "clear_db")]
    pub fn clear_db(&self) -> Result<()> {
        let mut w_txn = self
            .env
            .write_txn()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        self.units
            .clear(&mut w_txn)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        self.matrix
            .clear(&mut w_txn)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        self.namespaces
            .clear(&mut w_txn)
            .map_err(|e| Error::from_reason(e.to_string()))?;

        w_txn
            .commit()
            .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(())
    }
}
