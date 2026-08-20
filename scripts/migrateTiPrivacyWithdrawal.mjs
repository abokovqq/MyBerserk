import '../src/env.js';

import {
  q
} from '../src/db.js';


async function addColumnIfMissing({
  name,
  ddl
}) {
  const columns =
    await q(
      `SHOW COLUMNS FROM ti_users LIKE ?`,
      [
        name
      ]
    );


  if (columns.length) {
    console.log(
      `[SKIP] ${name} already exists`
    );

    return;
  }


  await q(
    `ALTER TABLE ti_users ADD COLUMN ${ddl}`
  );


  console.log(
    `[ADDED] ${name}`
  );
}


await addColumnIfMissing({
  name:
    'privacy_withdrawal_requested_at',

  ddl:
    `privacy_withdrawal_requested_at DATETIME NULL AFTER rating_group`
});


await addColumnIfMissing({
  name:
    'privacy_withdrawal_channel',

  ddl:
    `privacy_withdrawal_channel VARCHAR(32) NULL AFTER privacy_withdrawal_requested_at`
});


console.table(
  await q(
    `
      SELECT
        id,
        telegram_id,
        registration_status,
        rating_group,
        privacy_withdrawal_requested_at,
        privacy_withdrawal_channel

      FROM ti_users

      ORDER BY id ASC
    `
  )
);


process.exit(0);
