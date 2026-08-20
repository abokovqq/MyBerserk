import '../src/env.js';

import {
  q
} from '../src/db.js';


const columns =
  [
    {
      name:
        'rating_group',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN rating_group
           VARCHAR(32)
           NOT NULL
           DEFAULT 'main'`
    },

    {
      name:
        'privacy_withdrawal_requested_at',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN privacy_withdrawal_requested_at
           DATETIME NULL`
    },

    {
      name:
        'privacy_withdrawal_channel',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN privacy_withdrawal_channel
           VARCHAR(32) NULL`
    },

    {
      name:
        'rules_version',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN rules_version
           VARCHAR(32) NULL`
    },

    {
      name:
        'rules_accepted_at',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN rules_accepted_at
           DATETIME NULL`
    },

    {
      name:
        'privacy_consent_version',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN privacy_consent_version
           VARCHAR(32) NULL`
    },

    {
      name:
        'privacy_consent_at',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN privacy_consent_at
           DATETIME NULL`
    },

    {
      name:
        'rating_name_mode',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN rating_name_mode
           VARCHAR(32) NULL`
    },

    {
      name:
        'rating_publication_version',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN rating_publication_version
           VARCHAR(32) NULL`
    },

    {
      name:
        'rating_publication_decided_at',

      sql:
        `ALTER TABLE ti_users
         ADD COLUMN rating_publication_decided_at
           DATETIME NULL`
    }
  ];


async function main() {
  const existing =
    await q(
      `
        SHOW COLUMNS
        FROM ti_users
      `
    );


  const names =
    new Set(
      existing.map(
        row =>
          String(row.Field)
      )
    );


  for (
    const column
    of columns
  ) {
    if (
      names.has(
        column.name
      )
    ) {
      console.log(
        `[SKIP] ${column.name}`
      );

      continue;
    }


    await q(
      column.sql
    );


    console.log(
      `[ADDED] ${column.name}`
    );
  }


  // Если остались старые служебные значения
  // из промежуточной версии — объединяем их.
  await q(
    `
      UPDATE ti_users

      SET rating_group =
        'out_of_competition'

      WHERE rating_group
        IN (
          'admin',
          'owner',
          'developer'
        )
    `
  );


  await q(
    `
      UPDATE ti_users

      SET rating_group =
        'main'

      WHERE rating_group IS NULL

         OR rating_group NOT IN (
           'main',
           'out_of_competition'
         )
    `
  );


  console.log(
    '\nConsent status:'
  );


  console.table(
    await q(
      `
        SELECT
          id,
          telegram_id,
          phone_verified,
          registration_status,
          rating_group,

          rules_version,
          rules_accepted_at,

          privacy_consent_version,
          privacy_consent_at,

          rating_name_mode,
          rating_publication_version,
          rating_publication_decided_at,

          privacy_withdrawal_requested_at

        FROM ti_users

        ORDER BY id ASC
      `
    )
  );


  console.log(
    '\nIMPORTANT: existing users are NOT auto-consented.'
  );

  console.log(
    'They will see the consent flow on the next user action.'
  );
}


main()
  .then(
    () =>
      process.exit(0)
  )
  .catch(
    err => {
      console.error(err);

      process.exit(1);
    }
  );
