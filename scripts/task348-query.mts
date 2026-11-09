
  import { DatabaseSync } from 'node:sqlite';
  const db = new DatabaseSync(process.argv[2]);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM sign_events WHERE payment_digest = ? AND decision = 'approved'").get(process.argv[3]) as { n: number }).n;
  console.log(String(n));
  db.close();
  