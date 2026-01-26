import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Load environment variables
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(__dirname, '../../', envFile) });

// 2. Resolve the Database Path
// We use path.resolve to ensure Rust gets an absolute path (avoids "os error 2")
const rawPath = process.env.DB_PATH || './data/composia.mdb';
const absoluteDbPath = path.resolve(process.cwd(), rawPath);

// 3. Ensure the directory exists before the Engine starts
// LMDB needs the parent folder to exist to initialize the environment
if (!fs.existsSync(absoluteDbPath)) {
  fs.mkdirSync(absoluteDbPath, { recursive: true });
  console.log(`📁 Created database directory at: ${absoluteDbPath}`);
}

// 4. Load the native Rust binary
// Path: project_root/composia-native.node
const nativePath = path.resolve(__dirname, '../../composia_native.node');
const native = require(nativePath);

console.log(`🚀 Initializing Composia Engine at: ${absoluteDbPath}`);
// Ensure we are using the correct exported class name
export const engine = new native.ComposiaEngine(absoluteDbPath);
/**
 * Utility to clear the database (useful for testing)
 */
export const cleanDb = () => {
  engine.clear_db();
};

/**
 * Close the database connection safely
 */
export const closeDb = async () => {
  // LMDB closes automatically when the Node process exits
};