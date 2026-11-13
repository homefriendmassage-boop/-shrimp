// Admin-only transport. LINE ID tokens are verified by admin-api on every request.
function createAdminApiClient(config, getShopId) {
  async function call(payload) {
    const token = liff.getIDToken();
    if (!token) throw new Error('LINE_AUTH_INVALID');
    let response;
    try {
      response = await fetch(config.SUPABASE_URL + '/functions/v1/admin-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
        body: JSON.stringify({ ...payload, shop_id: getShopId() }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (_) { throw new Error('ADMIN_API_UNAVAILABLE'); }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || !result.ok) throw new Error(result?.code || 'ADMIN_API_HTTP_' + response.status);
    return result;
  }
  function from(table) {
    const request = { action: 'query', table, operation: 'select', columns: '*', filters: [], orders: [] };
    let pending;
    const query = {
      select(columns = '*') { request.columns = columns; request.returning = true; return query; },
      update(values, { rejectionReason } = {}) {
        request.operation = 'update';
        request.values = values;
        if (rejectionReason !== undefined) request.rejection_reason = rejectionReason;
        return query;
      },
      insert(values) { request.operation = 'insert'; request.values = values; return query; },
      delete() { request.operation = 'delete'; return query; },
      order(column, options = {}) { request.orders.push({ column, ascending: options.ascending !== false }); return query; },
      limit(count) { request.limit = count; return query; },
      single() { request.single = true; return query; },
      then(resolve, reject) {
        pending ||= call(request).then(result => ({ data: result.data, error: null })).catch(error => {
          if (typeof showAdminApiError === 'function') showAdminApiError(error.message);
          throw error;
        });
        return pending.then(resolve, reject);
      }
    };
    for (const op of ['eq', 'neq', 'gte', 'lte', 'lt', 'like', 'in']) {
      query[op] = (column, value) => { request.filters.push({ op, column, value }); return query; };
    }
    return query;
  }
  return {
    from,
    placeTableCashBet: details => call({ action: 'table_cash_bet', ...details }),
    setBoardPassword: password => call({ action: 'mc_board_set_password', password }),
    createCashTables: (count, limit) => call({ action: 'table_bulk_create', count, cash_limit: limit }),
    tableQr: table => call({ action: 'table_qr', table_no: table }),
    recordTableCash: (table, type, amount, id) => call({
      action: 'table_cash_payment', table_no: table, type, amount, entry_id: id,
    }),
    sendTableCashReport: (day, id) => call({ action: 'table_send_cash_report', day, delivery_id: id }),
    tableCashReport: day => call({ action: 'table_cash_report', day }),
    finalizeBalancedRound: (roundId, weight) => call({ action: 'round_finalize_balanced', round_id: roundId, weight }),
    approveWalletDeposit: requestId => call({ action: 'wallet_approve_deposit', request_id: String(requestId) }),
    approveWalletWithdrawal: requestId => call({ action: 'wallet_approve_withdrawal', request_id: String(requestId) }),
    access: () => call({ action: 'access' }),
    membershipSummary: () => call({ action: 'membership_summary' })
  };
}
