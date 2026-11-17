const statuses = {
  'Absolutely not': {
    state: 'no',
    overline: 'YOUR REQUEST HAS BEEN REVIEWED',
    title: 'ABSOLUTELY NOT.',
    description: 'The household is closed for visitors. Please resist the urge to “just pop by.”',
    aside: 'Yes, this includes “but we’re already nearby.”',
    chip: 'Visitors not welcome',
  },
  'Ask first': {
    state: 'ask',
    overline: 'CONDITIONAL ENTRY PROCEDURE',
    title: 'ASK FIRST.',
    description: 'A visit may be possible. Send us a message and wait for an actual yes before setting off.',
    aside: 'An unanswered message is not a yes, unfortunately.',
    chip: 'Approval required',
  },
  'Visitors welcome': {
    state: 'yes',
    overline: 'THE HOUSEHOLD HAS SPOKEN',
    title: 'COME ON OVER!',
    description: 'We’re up for visitors! Send a quick message so we know to put the kettle on.',
    aside: 'Please note: This is not an invitation to arrive unannounced.',
    chip: 'Visitors welcome',
  },

};

const elements = {
  overline: document.getElementById('decision-overline'),
  title: document.getElementById('verdict-title'),
  description: document.getElementById('verdict-description'),
  aside: document.getElementById('decision-aside'),
  chip: document.getElementById('chip-label'),
  updated: document.getElementById('last-updated'),
  refresh: document.getElementById('refresh'),
  demo: document.getElementById('demo-panel'),
};

let isDemo = false;
let busy = false;
let activePreview = new URLSearchParams(window.location.search).get('demo') || 'no';
const validPreviews = new Set(['no', 'ask', 'yes']);
if (!validPreviews.has(activePreview)) activePreview = 'no';

function setStatus(status, updatedAt, connected = false) {
  const view = statuses[status] || statuses['Absolutely not'];
  document.body.dataset.status = view.state;
  elements.overline.textContent = view.overline;
  elements.title.textContent = view.title;
  elements.description.textContent = view.description;
  elements.aside.textContent = view.aside;
  elements.chip.textContent = view.chip;
  if (!connected && !isDemo) {
    elements.updated.textContent = 'Home Assistant offline · NO visitors by default';
    elements.updated.removeAttribute('datetime');
  } else if (updatedAt && !Number.isNaN(Date.parse(updatedAt))) {
    const date = new Date(updatedAt);
    elements.updated.textContent = `Last changed ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`;
    elements.updated.dateTime = updatedAt;
  } else if (isDemo) {
    elements.updated.textContent = 'Preview mode · Not connected to Home Assistant';
  } else {
    elements.updated.textContent = 'Waiting for the first Home Assistant sync';
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  elements.refresh.disabled = true;
  elements.refresh.classList.add('spinning');
  try {
    const demoQuery = isDemo || new URLSearchParams(window.location.search).has('demo') ? `?demo=${encodeURIComponent(activePreview)}` : '';
    const response = await fetch(`/api/status${demoQuery}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Status request failed');
    const payload = await response.json();
    isDemo = payload.demo === true;
    setStatus(payload.status, payload.updatedAt, payload.connected === true);
    elements.demo.hidden = !isDemo;
    document.querySelectorAll('[data-demo]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.demo === activePreview));
    });
  } catch {
    setStatus('Absolutely not', null, false);
  } finally {
    busy = false;
    elements.refresh.disabled = false;
    elements.refresh.classList.remove('spinning');
  }
}

elements.refresh.addEventListener('click', refresh);
document.querySelectorAll('[data-demo]').forEach(button => {
  button.addEventListener('click', async () => {
    if (!isDemo) return;
    activePreview = button.dataset.demo;
    const url = new URL(window.location.href);
    url.searchParams.set('demo', activePreview);
    window.history.replaceState({}, '', url);
    await refresh();
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, 30_000);
