DO $$
DECLARE
    root_id VARCHAR(32) := 'stress_root';
    current_parent VARCHAR(32);
    new_unit_id VARCHAR(32);
    i INT;
BEGIN
    -- 1. Cleanup
    TRUNCATE units, instruction_matrix RESTART IDENTITY CASCADE;

    -- 2. Create the Stress Root
    INSERT INTO units (id, label, payload) 
    VALUES (root_id, 'The Big Bang Root', '{"init": true}'::jsonb);

    -- 3. SCENARIO: DEEP NESTING (15 Levels)
    current_parent := root_id;
    FOR i IN 1..15 LOOP
        new_unit_id := 'depth_node_' || i;
        -- CAST APPLIED HERE
        INSERT INTO units (id, label, payload) 
        VALUES (new_unit_id, 'Node Depth ' || i, ('{"level": ' || i || '}')::jsonb);
        
        INSERT INTO instruction_matrix (source, target, verb, namespace, "order") 
        VALUES (current_parent, new_unit_id, 'CHILD', 'stress_test', i);
        current_parent := new_unit_id;
    END LOOP;

    -- 4. SCENARIO: WIDE BRANCHING (100 Children)
    FOR i IN 1..100 LOOP
        new_unit_id := 'wide_node_' || i;
        -- CAST APPLIED HERE
        INSERT INTO units (id, label, payload) 
        VALUES (new_unit_id, 'Wide Child ' || i, ('{"index": ' || i || '}')::jsonb);
        
        INSERT INTO instruction_matrix (source, target, verb, namespace, "order") 
        VALUES (root_id, new_unit_id, 'CHILD', 'stress_test', i + 100);
    END LOOP;

    -- 5. SCENARIO: COMPLEX LOGIC OVERLOAD
    INSERT INTO units (id, label, payload) VALUES ('lib_template', 'Template', '{"template": true}'::jsonb);
    INSERT INTO units (id, label, payload) VALUES ('patch_unit', 'Patch', '{"patched": true}'::jsonb);

    INSERT INTO instruction_matrix (source, target, verb, value, namespace, "order")
    SELECT id, id, 'REPLACE', 'lib_template', 'stress_test', 1
    FROM units WHERE id LIKE 'wide_node_%';

    INSERT INTO instruction_matrix (source, target, verb, value, namespace, "order")
    SELECT 'lib_template', 'lib_template', 'OVERLAY', 'patch_unit', 'global', 1;

END $$;