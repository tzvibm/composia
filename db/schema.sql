-- Milestone 1: Atomic Unit Storage
CREATE TABLE IF NOT EXISTS units (
    id VARCHAR(32) PRIMARY KEY,    -- PK is a 32-bit hash (Hex string)
    label TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,    -- JSONB allows for the partial merges designed in #26
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Milestone 2: Instruction Matrix
CREATE TABLE IF NOT EXISTS instruction_matrix (
    instruction_pk UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source VARCHAR(32) NOT NULL REFERENCES units(id), 
    target TEXT NOT NULL,                             
    verb VARCHAR(20) NOT NULL,                        
    value TEXT,                                       
    namespace TEXT NOT NULL,                         
    "order" INTEGER NOT NULL,                         
    CONSTRAINT uq_instruction_logic UNIQUE (source, target, verb, namespace, "order")
);


CREATE INDEX idx_matrix_sovereign_logic 
ON instruction_matrix (source, namespace, verb, "order") 
INCLUDE (target);

CREATE INDEX idx_matrix_discovery 
ON instruction_matrix (source, namespace) 
WHERE verb = 'CHILD';