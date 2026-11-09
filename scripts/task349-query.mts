
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const rows = db.prepare(process.argv[3]).all() as unknown[];
console.log(JSON.stringify(rows));
db.close();
