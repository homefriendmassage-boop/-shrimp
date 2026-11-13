function shopAccountingDay(time = Date.now()) {
  return new Date(Number(time) + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shopAccountingWindow(day) {
  const start = new Date(day + 'T06:00:00+07:00');
  return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
}
