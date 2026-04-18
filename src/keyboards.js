export const kbCleaning = (taskId) => ({
  inline_keyboard: [
    [{ text:'Готово',  callback_data:`cleaning:done:${taskId}` }],
    [{ text:'Прочее',  callback_data:`cleaning:other:${taskId}` }]
  ]
});
