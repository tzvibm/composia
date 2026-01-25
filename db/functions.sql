-- db/functions.sql
DROP FUNCTION IF EXISTS resolve_sovereign_tree(VARCHAR, TEXT, INT);

CREATE OR REPLACE FUNCTION resolve_sovereign_tree(
    root_unit_id VARCHAR, 
    global_namespace TEXT, 
    max_depth INT DEFAULT 10
)
RETURNS TABLE (
    final_unit_id VARCHAR, 
    final_payload JSONB
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE sovereign_engine AS MATERIALIZED (
        -- INITIAL SEED: Working Memory
        SELECT 
            root_unit_id::VARCHAR AS current_id, 
            'SEED'::TEXT AS work_type, 
            0 AS current_depth

        UNION ALL

        SELECT 
            assembly_step.resolved_id, 
            'UNIT'::TEXT, 
            source_memory.current_depth + 1
        FROM sovereign_engine AS source_memory
        
        -- STEP 0: PHANTOM GUARD
        CROSS JOIN LATERAL (
            SELECT source_memory.current_id AS active_id 
            WHERE source_memory.work_type IN ('SEED', 'CHILD')
        ) AS guard_gate
        
        -- STEP 1: SINGLE QUERY TO INSTRUCTION MATRIX (The "Logic" Scan)
        CROSS JOIN LATERAL (
            SELECT 
                -- We gather the "Fate" of the unit using the index sort
                ARRAY_AGG(matrix.target ORDER BY matrix.verb, matrix."order") AS instruction_chain,
                -- Identify if we are replacing the unit
                COALESCE(MAX(CASE WHEN matrix.verb = 'REPLACE' THEN matrix.target END), guard_gate.active_id) AS target_id
            FROM instruction_matrix AS matrix
            WHERE matrix.source = guard_gate.active_id
              AND matrix.namespace = global_namespace
            -- HIDE CHECK: Use the index to see if we should even exist
            HAVING NOT COALESCE(BOOL_OR(matrix.verb = 'HIDE'), false)
        ) AS instruction_sweep

        -- STEP 2: SINGLE QUERY TO UNITS TABLE (The "Data" Scan)
        CROSS JOIN LATERAL (
            SELECT 
                u.id AS resolved_id,
                u.payload AS base_payload,
                ARRAY_AGG(ov.payload) AS overlay_payloads
            FROM units AS u
            -- Left join within the lateral to grab overlays in one hit
            LEFT JOIN units AS ov ON ov.id = ANY(instruction_sweep.instruction_chain)
            WHERE u.id = instruction_sweep.target_id
            GROUP BY u.id, u.payload
        ) AS data_fetch

        -- STEP 3: SHALLOW MERGE
        CROSS JOIN LATERAL (
            SELECT 
                data_fetch.resolved_id,
                data_fetch.base_payload || '{}'::jsonb AS merged_payload
        ) AS assembly_step
        
        WHERE source_memory.current_depth < max_depth
    )
    -- Only return the fully built UNITS to the user
    SELECT current_id, final_payload FROM sovereign_engine WHERE work_type = 'UNIT';
END;
$$ LANGUAGE plpgsql;