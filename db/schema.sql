-- Milestone 1: Atomic Unit Storage
CREATE TABLE IF NOT EXISTS units (
    id VARCHAR(32) PRIMARY KEY,    -- PK is a 32-bit hash (Hex string)
    label TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,    -- JSONB allows for the partial merges designed in #26
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Milestone 2: Instruction Matrix
CREATE TABLE IF NOT EXISTS instruction_matrix (
    instruction_pk UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- The unique address of the instruction
    source VARCHAR(32) NOT NULL REFERENCES units(id),    -- Register 1: The Context/Parent (32-bit Hash)
    target TEXT NOT NULL,    -- Register 2: The Subject (Unit ID or Instruction PK)   
    verb VARCHAR(20) NOT NULL,    -- The OpCode  
    value TEXT,    -- The Parameters  
    namespace TEXT NOT NULL,    -- The Sovereign 
    "order" INTEGER NOT NULL,    -- The Sequence & Priority
    CONSTRAINT uq_instruction_logic UNIQUE (source, target, verb, namespace, "order")    -- Ensures deterministic instruction execution
);

-- Optimized high-speed seek for the recursive Stitcher
CREATE INDEX IF NOT EXISTS idx_stitcher_seek ON instruction_matrix (source, namespace, "order");

-- Secondary index for target-based pruning (verbs like HIDE)
CREATE INDEX IF NOT EXISTS idx_instruction_target ON instruction_matrix (target);