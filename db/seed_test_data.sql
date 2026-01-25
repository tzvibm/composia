-- Clean start for testing
TRUNCATE units, instruction_matrix RESTART IDENTITY CASCADE;

-- Step 1: Create Units
INSERT INTO units (id, label, payload) VALUES
('root_node_001', 'Root Dashboard', '{"theme": "dark", "version": 1.0}'),
('child_node_001', 'Original Widget', '{"title": "Stock Ticker", "color": "blue"}'),
('lib_widget_001', 'Library Widget', '{"title": "Global Market Ticker", "color": "gold"}'),
('overlay_node_01', 'Patch data', '{"is_premium": true}');

-- Step 2: Build Hierarchy (Root -> Child)
INSERT INTO instruction_matrix (source, target, verb, namespace, "order") VALUES
('root_node_001', 'child_node_001', 'CHILD', 'main_app', 10);

-- Step 3: Global Instructions (The Logic)
INSERT INTO instruction_matrix (source, target, verb, value, namespace, "order") VALUES
-- When in 'main_app', Replace the original widget with the library version
('child_node_001', 'child_node_001', 'REPLACE', 'lib_widget_001', 'main_app', 1),

-- Mount a specific library namespace for this unit
('child_node_001', 'child_node_001', 'MOUNT', 'fin_library_v1', 'main_app', 2),

-- Apply an overlay to the library widget from the global namespace
('lib_widget_001', 'lib_widget_001', 'OVERLAY', 'overlay_node_01', 'global', 1);