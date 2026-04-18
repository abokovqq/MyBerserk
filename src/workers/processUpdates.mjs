// src/workers/processUpdates.mjs
import '../env.js';
import { q } from '../db.js';

async function main() {
  // берём необработанные апдейты
  const rows = await q(
    "SELECT id, payload FROM telegram_updates WHERE processed = 0 ORDER BY id ASC LIMIT 500"
  );

  for (const row of rows) {
    let upd;
    try {
      upd = (typeof row.payload === 'string')
        ? JSON.parse(row.payload)
        : row.payload;
    } catch (e) {
      // сломанный json
      await q("UPDATE telegram_updates SET processed = 2 WHERE id = ?", [row.id]);
      continue;
    }

    try {
      let handled = false;

      // --- обрабатываем callback вида cleaning:...:id ---
      if (upd.callback_query) {
        const cb = upd.callback_query;
        const data = cb.data || '';
        const from = cb.from || {};
        const telegramId = from.id || null;
        const firstName =
          (from.first_name && from.first_name.trim() !== '')
            ? from.first_name.trim()
            : (from.username ? from.username : null);

        const m = data.match(/^cleaning:(done|other|late):(\d+)$/);
        if (m) {
          const action = m[1];    // done | other | late
          const taskId = Number(m[2]);

          // маппинг под твою таблицу
          let newStatus = 'open';
          if (action === 'done') newStatus = 'done';
          else if (action === 'other') newStatus = 'noneed'; // "не нужно"
          else if (action === 'late') newStatus = 'late';    // "не успел"

          // обновляем cleaning_tasks
          await q(
            `UPDATE cleaning_tasks
             SET status = ?, 
                 actor_telegram_id = ?, 
                 first_name = ?, 
                 closed_at = NOW()
             WHERE id = ?`,
            [newStatus, telegramId, firstName, taskId]
          );

          handled = true;
        }
      }

      // если дошли сюда — апдейт либо обработан, либо нам неинтересен
      await q(
        "UPDATE telegram_updates SET processed = ? WHERE id = ?",
        [handled ? 1 : 1, row.id]   // помечаем как обработанный в любом случае
      );

    } catch (e) {
      // если что-то упало в обработке
      await q("UPDATE telegram_updates SET processed = 2 WHERE id = ?", [row.id]);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(1));
