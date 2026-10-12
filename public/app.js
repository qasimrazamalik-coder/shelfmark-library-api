// Shelfmark frontend: plain JavaScript, no build step.
// Everything here talks to the API; all rules live on the server.

const $view = document.getElementById('view');
const store = {
  get token() { try { return localStorage.getItem('sm.token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('sm.token', v) : localStorage.removeItem('sm.token'); } catch {} },
};
let me = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const stampDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
const isStaff = () => me && (me.role === 'librarian' || me.role === 'admin');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && store.token) { store.token = null; me = null; route(); }
  if (!res.ok) {
    const e = new Error(data.error?.message || 'Request failed');
    e.code = data.error?.code; e.details = data.error?.details;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

// ---------- chrome ----------
function renderChrome(current) {
  const links = me
    ? [['catalogue', 'Catalogue'], ['shelf', 'My shelf'], ...(isStaff() ? [['desk', 'Circulation desk']] : [])]
    : [['catalogue', 'Catalogue']];
  document.getElementById('nav').innerHTML = links
    .map(([k, label]) => `<a href="#/${k}" ${k === current ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  document.getElementById('who').innerHTML = me
    ? `<strong>${esc(me.name)}</strong>Card ${esc(me.cardNumber)}<br><button id="signout">Sign out</button>`
    : `<a href="#/signin" style="color:#fff">Sign in</a>`;
  document.getElementById('signout')?.addEventListener('click', () => { store.token = null; me = null; location.hash = '#/signin'; });
}

// ---------- sign in ----------
function viewSignin(mode = 'in') {
  renderChrome('');
  $view.innerHTML = `
    <div class="signin">
      <h1>${mode === 'in' ? 'Sign in to the library' : 'Get a library card'}</h1>
      <p class="lede">${mode === 'in' ? 'Borrow books, renew loans and join waiting lists.' : 'A card number is issued as soon as you register.'}</p>
      <form id="f" novalidate>
        ${mode === 'up' ? '<div><label for="name">Full name</label><input id="name" autocomplete="name" required></div>' : ''}
        <div><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
        <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" required></div>
        <button class="btn" type="submit">${mode === 'in' ? 'Sign in' : 'Create account'}</button>
        <p class="err" id="err" hidden></p>
      </form>
      <p class="switch">${mode === 'in' ? 'New here? <button id="sw">Get a library card</button>' : 'Already have a card? <button id="sw">Sign in</button>'}</p>
      <div class="demo">Trying the demo? Use
        <button data-demo="amina@shelfmark.test">a member</button> or
        <button data-demo="librarian@shelfmark.test">the librarian</button>. Password is password123.</div>
    </div>`;
  document.getElementById('sw').onclick = () => viewSignin(mode === 'in' ? 'up' : 'in');
  $view.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => {
    document.getElementById('email').value = b.dataset.demo;
    document.getElementById('pw').value = 'password123';
  }));
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.hidden = true;
    const body = { email: document.getElementById('email').value, password: document.getElementById('pw').value };
    if (mode === 'up') body.name = document.getElementById('name').value;
    try {
      const r = await api(mode === 'in' ? '/auth/login' : '/auth/register', { method: 'POST', body });
      store.token = r.token; me = r.user;
      location.hash = r.user.role === 'member' ? '#/shelf' : '#/desk';
    } catch (ex) {
      err.textContent = ex.details ? ex.details.map((d) => `${d.field}: ${d.message}`).join(' ') : ex.message;
      err.hidden = false;
    }
  };
}

// ---------- catalogue ----------
let catState = { q: '', subject: null };
async function viewCatalogue() {
  renderChrome('catalogue');
  $view.innerHTML = `
    <h1>Catalogue</h1>
    <p class="lede">Search by title, author or subject. Partial words work, so "kahn" finds Kahneman.</p>
    <div class="search"><label for="q" class="sr">Search the catalogue</label>
      <input id="q" placeholder="Try dune, orwell or databases" value="${esc(catState.q)}" autocomplete="off"></div>
    <div class="subjects" id="subjects"></div>
    <ul class="results" id="results"></ul>`;
  const q = document.getElementById('q');
  let debounce;
  q.oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => { catState.q = q.value; loadResults(); }, 180); };
  q.focus();
  const subjects = await api('/books/subjects');
  const box = document.getElementById('subjects');
  const drawSubjects = () => {
    box.innerHTML = subjects.map((s) => `<button class="chip" data-s="${esc(s.subject)}" aria-pressed="${catState.subject === s.subject}">${esc(s.subject)}</button>`).join('');
  };
  drawSubjects();
  box.onclick = (e) => {
    const s = e.target.dataset?.s;
    if (!s) return;
    catState.subject = catState.subject === s ? null : s;
    drawSubjects();
    loadResults();
  };
  loadResults();
}

async function loadResults() {
  const params = new URLSearchParams({ limit: 50 });
  if (catState.q) params.set('q', catState.q);
  if (catState.subject) params.set('subject', catState.subject);
  const { items, total } = await api(`/books?${params}`);
  const list = document.getElementById('results');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<li class="empty" style="display:block;cursor:default">Nothing matches "${esc(catState.q)}". Check the spelling or clear the subject filter.</li>`;
    return;
  }
  list.innerHTML = items.map((b) => `
    <li data-id="${b.id}" tabindex="0">
      <span class="t">${esc(b.title)}</span>
      <span class="avail">${b.availableCopies > 0
        ? `<span class="on-shelf">${b.availableCopies} of ${b.totalCopies} on the shelf</span>`
        : `<span class="all-out">All out${b.queueLength ? `, ${b.queueLength} waiting` : ''}</span>`}</span>
      <span class="a">${esc(b.author)}${b.publishedYear ? `, ${b.publishedYear}` : ''}</span>
    </li>`).join('') + (total > items.length ? `<li class="empty">Showing ${items.length} of ${total}. Narrow your search to see the rest.</li>` : '');
  list.onclick = (e) => { const li = e.target.closest('li[data-id]'); if (li) openBook(li.dataset.id); };
  list.onkeydown = (e) => { if (e.key === 'Enter') { const li = e.target.closest('li[data-id]'); if (li) openBook(li.dataset.id); } };
}

async function openBook(id) {
  const b = await api(`/books/${id}`);
  const bg = document.createElement('div');
  bg.className = 'drawer-bg';
  const canBorrow = me && b.availableCopies > 0;
  const canHold = me && b.availableCopies === 0 && b.totalCopies > 0;
  bg.innerHTML = `
    <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="bt">
      <button class="btn quiet close" id="x">Close</button>
      <h2 id="bt">${esc(b.title)}</h2>
      <p class="meta">${esc(b.author)}${b.publishedYear ? `, ${b.publishedYear}` : ''}${b.isbn ? `<br>ISBN ${esc(b.isbn)}` : ''}</p>
      <p>${b.subjects.map((s) => `<span class="chip" style="cursor:default">${esc(s)}</span>`).join(' ')}</p>
      <table class="copies">
        <thead><tr><th>Copy</th><th>Shelf</th><th>Status</th></tr></thead>
        <tbody>${b.copies.map((c) => `<tr><td>${esc(c.barcode)}</td><td>${esc(c.shelfLocation || '')}</td><td>${
          c.status === 'available' ? '<span class="on-shelf">On the shelf</span>'
          : c.status === 'on_loan' ? `Due back ${fmtDate(c.dueAt)}`
          : c.status === 'on_hold_shelf' ? 'Kept for someone' : esc(c.status)}</td></tr>`).join('') || '<tr><td colspan="3">No copies yet.</td></tr>'}</tbody>
      </table>
      ${b.queueLength ? `<p class="meta">${plural(b.queueLength, 'person')} waiting.</p>` : ''}
      ${canBorrow ? '<button class="btn" id="go">Borrow this book</button>' : ''}
      ${canHold ? '<button class="btn" id="go">Join the waiting list</button>' : ''}
      ${!me ? '<p class="meta"><a href="#/signin">Sign in</a> to borrow or join the waiting list.</p>' : ''}
      <p class="err" id="derr" hidden></p>
    </div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  bg.onclick = (e) => e.target === bg && close();
  bg.querySelector('#x').onclick = close;
  bg.querySelector('#x').focus();
  const go = bg.querySelector('#go');
  if (go) go.onclick = async () => {
    go.disabled = true;
    try {
      if (canBorrow) {
        const loan = await api('/loans', { method: 'POST', body: { bookId: b.id } });
        close();
        toast(`Borrowed. Due back ${fmtDate(loan.dueAt)}.`);
        sessionStorage.setItem('sm.justStamped', loan.id);
        location.hash = '#/shelf';
      } else {
        const h = await api('/holds', { method: 'POST', body: { bookId: b.id } });
        close();
        toast(`You're number ${h.position} in line.`);
        loadResults();
      }
    } catch (ex) {
      const e = bg.querySelector('#derr'); e.textContent = ex.message; e.hidden = false; go.disabled = false;
    }
  };
}

// ---------- my shelf ----------
const blockerText = {
  OVERDUE: 'Overdue, so it can\'t be renewed',
  RENEWAL_LIMIT: 'Renewed twice already',
  TITLE_ON_HOLD: 'Someone is waiting for it',
};

async function viewShelf() {
  if (!me) return (location.hash = '#/signin');
  renderChrome('shelf');
  const [loans, holds, fines, standing] = await Promise.all([
    api('/loans'), api('/holds'), api('/fines?status=unpaid'), api('/loans/standing'),
  ]);
  const justStamped = sessionStorage.getItem('sm.justStamped');
  sessionStorage.removeItem('sm.justStamped');

  const standingLine = standing.canBorrow
    ? `<strong>Yes</strong>You can borrow`
    : `<strong class="blocked">Not right now</strong>${standing.blockers.includes('HAS_OVERDUE') ? 'Return overdue books first' : standing.blockers.includes('FINES_OWED') ? 'Settle fines at the desk' : 'Loan limit reached'}`;

  $view.innerHTML = `
    <h1>My shelf</h1>
    <div class="standing">
      <div><strong>${standing.activeLoans} / ${standing.maxLoans}</strong>Books out</div>
      <div><strong class="money ${standing.unpaidCents ? 'blocked' : ''}">${money(standing.unpaidCents)}</strong>Fines owed</div>
      <div>${standingLine}</div>
    </div>
    <section>
      <div class="section-head"><h2>On loan</h2></div>
      ${loans.length ? `<div class="slips">${loans.map((l) => slip(l, String(l.id) === justStamped)).join('')}</div>`
        : '<p class="empty">Nothing on loan. <a href="#/catalogue">Find something to read</a>.</p>'}
    </section>
    <section>
      <div class="section-head"><h2>Waiting list</h2></div>
      ${holds.length ? `<ul class="plain">${holds.map((h) => `
        <li><div><strong>${esc(h.title)}</strong>
          <div class="sub">${h.status === 'ready'
            ? `Ready at the desk. Collect by ${fmtDate(h.pickupBy)}.`
            : `Number ${h.position} in line`}</div></div>
          <button class="btn quiet" data-cancel="${h.id}">Leave the list</button></li>`).join('')}</ul>`
        : '<p class="empty">You are not waiting for anything.</p>'}
    </section>
    ${fines.length ? `<section>
      <div class="section-head"><h2>Fines</h2></div>
      <ul class="plain">${fines.map((f) => `<li><div><strong>${esc(f.title)}</strong><div class="sub">${esc(f.reason)}, ${fmtDate(f.createdAt)}</div></div>
        <span class="money">${money(f.amountCents)}</span></li>`).join('')}</ul>
      <p class="lede">Pay at the circulation desk.</p></section>` : ''}`;

  $view.onclick = async (e) => {
    const renew = e.target.dataset?.renew;
    const cancel = e.target.dataset?.cancel;
    try {
      if (renew) {
        e.target.disabled = true;
        const l = await api(`/loans/${renew}/renew`, { method: 'POST' });
        sessionStorage.setItem('sm.justStamped', l.id);
        toast(`Renewed. New due date ${fmtDate(l.dueAt)}.`);
        viewShelf();
      } else if (cancel) {
        await api(`/holds/${cancel}`, { method: 'DELETE' });
        toast('Removed from the waiting list.');
        viewShelf();
      }
    } catch (ex) { toast(ex.message, true); e.target.disabled = false; }
  };
}

function slip(l, thunk) {
  const late = l.daysOverdue > 0;
  return `
    <article class="slip">
      <div class="slip-label">Date due slip, copy ${esc(l.barcode)}</div>
      <div class="t">${esc(l.title)}</div>
      <div class="a">${esc(l.author)}</div>
      <div class="stamp ${late ? 'late' : ''} ${thunk ? 'thunk' : ''}">${late ? 'OVERDUE' : stampDate(l.dueAt)}</div>
      ${late ? `<p class="why" style="color:var(--late)">${plural(l.daysOverdue, 'day')} late. Fine so far ${money(l.accruingCents)}.</p>` : ''}
      <div class="foot">
        <span>${l.renewalsLeft} renewal${l.renewalsLeft === 1 ? '' : 's'} left</span>
        <button class="btn quiet" data-renew="${l.id}" ${l.canRenew ? '' : 'disabled'}>Renew</button>
      </div>
      ${!l.canRenew && l.renewBlockers[0] ? `<p class="why">${blockerText[l.renewBlockers[0]] || ''}</p>` : ''}
    </article>`;
}

// ---------- circulation desk ----------
const deskLog = { out: [], in: [] };
async function viewDesk() {
  if (!isStaff()) return (location.hash = '#/catalogue');
  renderChrome('desk');
  $view.innerHTML = `
    <h1>Circulation desk</h1>
    <div class="counters" id="counters"></div>
    <div class="desk-grid">
      <form class="station" id="outF">
        <h2>Check out</h2>
        <div><label for="card">Library card</label><input id="card" placeholder="SM-2041-7730" autocomplete="off"></div>
        <div class="field-row"><div><label for="outB">Book barcode</label><input id="outB" placeholder="B0005-1" autocomplete="off"></div>
          <button class="btn">Lend</button></div>
        <div class="receipt" id="outLog"></div>
      </form>
      <form class="station" id="inF">
        <h2>Check in</h2>
        <div class="field-row"><div><label for="inB">Book barcode</label><input id="inB" placeholder="B0008-1" autocomplete="off"></div>
          <button class="btn">Return</button></div>
        <div class="receipt" id="inLog"></div>
      </form>
    </div>
    <div class="two-col" style="margin-top:44px">
      <section><div class="section-head"><h2>Overdue</h2></div><ul class="plain" id="overdue"></ul></section>
      <section style="margin-top:0"><div class="section-head"><h2>Hold shelf</h2></div><ul class="plain" id="shelfHolds"></ul></section>
    </div>
    <div class="two-col" style="margin-top:44px">
      <section><div class="section-head"><h2>Unpaid fines</h2></div><ul class="plain" id="fines"></ul></section>
      <section style="margin-top:0"><div class="section-head"><h2>Add a title</h2></div>
        <form id="addF" class="station" style="display:flex;flex-direction:column;gap:10px">
          <div><label for="nt">Title</label><input id="nt" required></div>
          <div><label for="na">Author</label><input id="na" required></div>
          <div class="field-row"><div><label for="ny">Year</label><input id="ny" type="number"></div>
            <div><label for="nc">First copy barcode</label><input id="nc" placeholder="B0100-1"></div></div>
          <div><label for="ns">Subjects, comma separated</label><input id="ns"></div>
          <button class="btn">Add to catalogue</button>
        </form></section>
    </div>`;

  const drawLog = (id, lines) => {
    document.getElementById(id).innerHTML = lines.map((l) =>
      `<div class="line ${l.cls || ''}"><time>${l.t}</time><span>${l.html}</span></div>`).join('');
  };
  const stamp = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  drawLog('outLog', deskLog.out); drawLog('inLog', deskLog.in);

  document.getElementById('outF').onsubmit = async (e) => {
    e.preventDefault();
    const card = document.getElementById('card').value.trim();
    const bc = document.getElementById('outB');
    try {
      const l = await api('/loans', { method: 'POST', body: { barcode: bc.value.trim(), memberCard: card } });
      deskLog.out.unshift({ t: stamp(), html: `<strong>${esc(l.title)}</strong> to ${esc(l.memberName)}, due ${fmtDate(l.dueAt)}` });
    } catch (ex) { deskLog.out.unshift({ t: stamp(), cls: 'bad', html: esc(ex.message) }); }
    bc.value = ''; bc.focus(); drawLog('outLog', deskLog.out); refreshLists();
  };
  document.getElementById('inF').onsubmit = async (e) => {
    e.preventDefault();
    const bc = document.getElementById('inB');
    try {
      const r = await api('/loans/return', { method: 'POST', body: { barcode: bc.value.trim() } });
      let html = `<strong>${esc(r.loan.title)}</strong> back from ${esc(r.loan.memberName)}`;
      if (r.fine) html += `. Late ${plural(r.daysLate, 'day')}, fine ${money(r.fine.amountCents)}`;
      html += r.heldFor
        ? `.<br><span class="hold">Put it on the hold shelf for ${esc(r.heldFor.memberName)}.</span>`
        : '.<br>Reshelve it.';
      deskLog.in.unshift({ t: stamp(), html });
    } catch (ex) { deskLog.in.unshift({ t: stamp(), cls: 'bad', html: esc(ex.message) }); }
    bc.value = ''; bc.focus(); drawLog('inLog', deskLog.in); refreshLists();
  };
  document.getElementById('addF').onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id).value.trim();
    try {
      const book = await api('/books', { method: 'POST', body: {
        title: v('nt'), author: v('na'),
        ...(v('ny') ? { publishedYear: Number(v('ny')) } : {}),
        subjects: v('ns') ? v('ns').split(',').map((s) => s.trim()).filter(Boolean) : [],
      } });
      if (v('nc')) await api(`/books/${book.id}/copies`, { method: 'POST', body: { barcode: v('nc').toUpperCase() } });
      toast(`Added "${book.title}".`);
      e.target.reset();
    } catch (ex) { toast(ex.details ? ex.details.map((d) => d.message).join(' ') : ex.message, true); }
  };
  $view.onclick = async (e) => {
    const pay = e.target.dataset?.pay;
    if (!pay) return;
    try { await api(`/fines/${pay}/pay`, { method: 'POST' }); toast('Payment recorded.'); refreshLists(); }
    catch (ex) { toast(ex.message, true); }
  };
  refreshLists();
}

async function refreshLists() {
  const [s, overdue, shelf, fines] = await Promise.all([
    api('/staff/summary'), api('/loans?overdue=true'), api('/holds?scope=shelf'), api('/fines?status=unpaid'),
  ]);
  const c = document.getElementById('counters');
  if (!c) return;
  c.innerHTML = `
    <div><strong>${s.onLoan}</strong>On loan</div>
    <div class="${s.overdue ? 'warn' : ''}"><strong>${s.overdue}</strong>Overdue</div>
    <div><strong>${s.onHoldShelf}</strong>On hold shelf</div>
    <div><strong>${s.waitingHolds}</strong>Waiting</div>
    <div><strong>${s.loansToday} / ${s.returnsToday}</strong>Out / in today</div>
    <div><strong class="money">${money(s.unpaidCents)}</strong>Unpaid</div>`;
  document.getElementById('overdue').innerHTML = overdue.map((l) => `
    <li><div><strong>${esc(l.title)}</strong><div class="sub">${esc(l.memberName)}, copy ${esc(l.barcode)}</div></div>
      <span style="color:var(--late)">${plural(l.daysOverdue, 'day')}</span></li>`).join('') || '<li class="sub">Nothing overdue.</li>';
  document.getElementById('shelfHolds').innerHTML = shelf.map((h) => `
    <li><div><strong>${esc(h.title)}</strong><div class="sub">For ${esc(h.memberName)}, copy ${esc(h.barcode)}</div></div>
      <span class="sub">until ${fmtDate(h.pickupBy)}</span></li>`).join('') || '<li class="sub">The hold shelf is empty.</li>';
  document.getElementById('fines').innerHTML = fines.map((f) => `
    <li><div><strong>${esc(f.memberName)}</strong><div class="sub">${esc(f.title)}: ${esc(f.reason)}</div></div>
      <span><span class="money">${money(f.amountCents)}</span> <button class="btn quiet" data-pay="${f.id}">Mark paid</button></span></li>`).join('') || '<li class="sub">No unpaid fines.</li>';
}

// ---------- router ----------
async function route() {
  if (store.token && !me) {
    try { me = await api('/auth/me'); } catch { me = null; }
  }
  const page = (location.hash.replace(/^#\//, '') || (me ? (isStaff() ? 'desk' : 'shelf') : 'catalogue')).split('/')[0];
  $view.onclick = null;
  try {
    if (page === 'signin') viewSignin();
    else if (page === 'shelf') await viewShelf();
    else if (page === 'desk') await viewDesk();
    else await viewCatalogue();
  } catch (ex) {
    $view.innerHTML = `<h1>Couldn't load this page</h1><p class="lede">${esc(ex.message)} Check the server is running, then reload.</p>`;
  }
  $view.focus();
}
window.addEventListener('hashchange', route);
route();
