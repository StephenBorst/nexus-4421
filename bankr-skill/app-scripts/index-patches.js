// ── PATCH 1: replace sync() in index.html ────────────────────────────────────
async function sync() {
  const btn = $('refreshBtn');
  btn.querySelector('svg').classList.add('spinning');

  try {
    const res = await bankr.invokeScript('syncNexus', {});
    if (res.needsAgent) {
      renderNeedsAgent(res.error);
      btn.querySelector('svg').classList.remove('spinning');
      return;
    }
    if (res.error) throw new Error(res.error);
  } catch (e) {
    console.log('sync error', e.message);
  }

  await load();
  btn.querySelector('svg').classList.remove('spinning');
}

// ── PATCH 2: add renderNeedsAgent() alongside renderError() ──────────────────
function renderNeedsAgent(errorCode) {
  const isNotRegistered = errorCode === 'wallet_not_registered';
  const msg = isNotRegistered
    ? 'Your wallet isn\'t registered on Nexus yet.'
    : 'Your Nexus session needs activating.';
  const action = isNotRegistered
    ? 'register with nexus'
    : 'check my nexus balance';

  $('positions').innerHTML = `
    <div style="text-align:center;padding:60px 20px">
      <div style="font-size:32px;margin-bottom:16px">🔗</div>
      <div style="color:var(--text);font-size:15px;font-weight:600;margin-bottom:8px">${msg}</div>
      <div style="color:var(--text2);font-size:13px;margin-bottom:24px">
        Tap below to activate via the Nexus agent — takes one message, then sync works automatically.
      </div>
      <button onclick="bankr.prefillChat('${action}')"
        style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">
        ${isNotRegistered ? 'Register on Nexus' : 'Activate Session'}
      </button>
    </div>`;
  $('stats').innerHTML = '';
  $('trades').innerHTML = '';
  $('marketStats').innerHTML = '';
  $('plChart').style.display = 'none';
}

function renderError(msg) {
  $('positions').innerHTML = '<div class="error">' + msg + '</div>';
  $('stats').innerHTML = '';
  $('trades').innerHTML = '';
  $('marketStats').innerHTML = '';
  $('plChart').style.display = 'none';
}
