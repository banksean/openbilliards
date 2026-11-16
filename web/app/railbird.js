// Copyright (c) Meta Platforms, Inc. and affiliates.

// railbird.js — opt-in adapter for layouts exported by the unrelated
// Railbird video-inference application. The boundary is deliberately small:
// this module knows Railbird's export shape, while game.js continues to know
// only kernel-frame layouts.

export const RAILBIRD_BOUNDS = Object.freeze({
  left: 200, right: 1200, top: 200, bottom: 700,
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (message) => { throw new Error(`Railbird data refused: ${message}`); };

/** Validate the interchange subset used by this viewer. */
export function parseRailbirdExport(value) {
  const shots = value?.getOrderedShots?.shots;
  if (!Array.isArray(shots)) fail('getOrderedShots.shots must be an array');
  if (!shots.length) fail('getOrderedShots.shots is empty');
  return shots.map((shot, shotIndex) => {
    if (!shot || typeof shot !== 'object') fail(`shots[${shotIndex}] must be an object`);
    if (!Array.isArray(shot.cleanPaths)) fail(`shots[${shotIndex}].cleanPaths must be an array`);
    const seen = new Set();
    const paths = shot.cleanPaths.map((path, pathIndex) => {
      const at = `shots[${shotIndex}].cleanPaths[${pathIndex}]`;
      if (!path || typeof path !== 'object') fail(`${at} must be an object`);
      if (!finite(path.ballId)) fail(`${at}.ballId must be a finite number`);
      if (seen.has(path.ballId)) fail(`${at}.ballId duplicates ${path.ballId}`);
      seen.add(path.ballId);
      if (typeof path.isCueBall !== 'boolean') fail(`${at}.isCueBall must be boolean`);
      if (!finite(path.restPoint?.x) || !finite(path.restPoint?.y)) {
        fail(`${at}.restPoint must contain finite x and y`);
      }
      return {
        ballId: path.ballId,
        isCueBall: path.isCueBall,
        restPoint: { x: path.restPoint.x, y: path.restPoint.y },
      };
    });
    const cues = paths.filter((p) => p.isCueBall);
    if (cues.length !== 1) fail(`shots[${shotIndex}] must contain exactly one cue ball`);
    if (paths.length - 1 > 15) fail(`shots[${shotIndex}] contains more than 15 object balls`);
    return { id: shot.id ?? null, index: shotIndex, paths };
  });
}

/** Deterministically alias Railbird tracking ids onto renderer ids 0..15. */
export function aliasRailbirdShot(shot) {
  const cue = shot.paths.find((p) => p.isCueBall);
  const objects = shot.paths.filter((p) => !p.isCueBall)
    .sort((a, b) => a.ballId - b.ballId);
  const aliases = new Map([[cue.ballId, 0]]);
  objects.forEach((path, i) => aliases.set(path.ballId, i + 1));
  return aliases;
}

/**
 * Railbird image/table coordinates -> kernel coordinates. Railbird x runs
 * along the table length; screen y runs downward across its width.
 */
export function convertRailbirdShot(shot, table, radius) {
  if (!finite(table?.length) || !(table.length > 0)
    || !finite(table?.width) || !(table.width > 0)) fail('active table dimensions unavailable');
  if (!finite(radius) || !(radius > 0)) fail('active ball radius unavailable');
  const aliases = aliasRailbirdShot(shot);
  const minX = -table.width / 2 + radius;
  const maxX = table.width / 2 - radius;
  const minY = -table.length / 2 + radius;
  const maxY = table.length / 2 - radius;
  let clamped = 0;
  const layout = shot.paths.map((path) => {
    const u = (path.restPoint.x - RAILBIRD_BOUNDS.left)
      / (RAILBIRD_BOUNDS.right - RAILBIRD_BOUNDS.left);
    const v = (path.restPoint.y - RAILBIRD_BOUNDS.top)
      / (RAILBIRD_BOUNDS.bottom - RAILBIRD_BOUNDS.top);
    const rawX = (0.5 - v) * table.width;
    // Railbird image x increases toward the renderer's NEGATIVE long axis.
    // Keeping the old positive sign mirrored every imported layout end-to-end.
    const rawY = (0.5 - u) * table.length;
    const x = Math.max(minX, Math.min(maxX, rawX));
    const y = Math.max(minY, Math.min(maxY, rawY));
    if (x !== rawX || y !== rawY) clamped += 1;
    return {
      id: aliases.get(path.ballId), x, y,
      railbirdId: path.ballId, isCueBall: path.isCueBall,
      source: { ...path.restPoint }, clamped: x !== rawX || y !== rawY,
    };
  }).sort((a, b) => a.id - b.id);
  return { layout, aliases, clamped };
}

function ensureSheet() {
  if (document.getElementById('ob-railbird-css')) return;
  const link = document.createElement('link');
  link.id = 'ob-railbird-css';
  link.rel = 'stylesheet';
  link.href = new URL('./ui/railbird.css?v=001', import.meta.url).href;
  link.dataset.optional = '';
  document.head.appendChild(link);
}

function makePanel() {
  const panel = document.createElement('section');
  panel.id = 'ob-railbird';
  panel.className = 'ob-panel';
  panel.setAttribute('aria-label', 'Railbird layout viewer');
  panel.innerHTML = `
    <div class="ob-rb-head">
      <div><strong>Railbird layout</strong><div id="ob-rb-shot" class="ob-nums"></div></div>
      <div class="ob-rb-actions">
        <button id="ob-rb-prev" class="ob-btn" type="button" aria-label="Previous shot">&#8592;</button>
        <button id="ob-rb-next" class="ob-btn" type="button" aria-label="Next shot">&#8594;</button>
      </div>
    </div>
    <p id="ob-rb-status" role="status" aria-live="polite"></p>
    <details><summary>Ball aliases</summary><div id="ob-rb-legend" class="ob-nums"></div></details>`;
  document.body.appendChild(panel);
  return {
    panel,
    shot: panel.querySelector('#ob-rb-shot'),
    status: panel.querySelector('#ob-rb-status'),
    legend: panel.querySelector('#ob-rb-legend'),
    prev: panel.querySelector('#ob-rb-prev'),
    next: panel.querySelector('#ob-rb-next'),
  };
}

function installInputGate(panel) {
  const gate = (event) => {
    if (panel.contains(event.target)) return;
    const pointer = event.type === 'pointerdown' || event.type === 'mousedown';
    // Preserve the app's documented orbit gestures: right-drag or shift-drag.
    if (pointer && (event.button === 2 || event.shiftKey)) return;
    // Preserve shift-wheel zoom; unmodified wheel changes shot power.
    if (event.type === 'wheel' && event.shiftKey) return;
    // Outside the viewer panel, every unmodified action key belongs to the
    // game/shell. Keep Tab navigation, Escape dismissal and browser/OS
    // shortcuts; focused viewer controls are exempt above.
    const gameplayKey = event.type === 'keydown'
      && !event.metaKey && !event.ctrlKey && !event.altKey
      && event.key !== 'Tab' && event.key !== 'Escape';
    const gameplayPointer = pointer || event.type === 'touchstart'
      || event.type === 'click' || event.type === 'dblclick' || event.type === 'wheel';
    if (!gameplayKey && !gameplayPointer) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'wheel', 'keydown']) {
    window.addEventListener(type, gate, { capture: true, passive: false });
  }
}

/** Install the URL-driven, read-only Railbird layout viewer. */
export async function createRailbirdViewer({ game, sourceUrl, initialShot = 0, reportError }) {
  ensureSheet();
  document.documentElement.classList.add('ob-railbird-mode');
  const ui = makePanel();
  installInputGate(ui.panel);
  const originalShoot = game.shoot;
  game.shoot = () => 'Railbird viewer is read-only';

  const diagnostic = {
    state: 'loading', sourceUrl, selected: null, count: 0,
    shotId: null, aliases: [], clamped: 0, layout: [], error: null,
  };
  window.__railbird = { state: () => structuredClone(diagnostic) };
  ui.status.textContent = 'Loading inference data…';

  try {
    const response = await fetch(sourceUrl, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`fetch returned HTTP ${response.status}`);
    const shots = parseRailbirdExport(await response.json());
    diagnostic.count = shots.length;

    // The renderer needs enough numbered meshes for every possible imported
    // object. Missing aliases are hidden by game.layout().
    game.rerackKind('fifteen', 1);
    const table = game.template?.system?.table;
    const radius = game.template?.system?.balls?.[0]?.params?.r;

    const select = (requested, { history = true } = {}) => {
      const n = Number(requested);
      const index = Number.isInteger(n) ? Math.max(0, Math.min(shots.length - 1, n)) : 0;
      const shot = shots[index];
      const converted = convertRailbirdShot(shot, table, radius);
      game.layout(converted.layout.map(({ id, x, y }) => ({ id, x, y })));
      ui.shot.textContent = `${index + 1} / ${shots.length} · shot ${shot.id ?? 'unknown'}`;
      ui.status.textContent = converted.clamped
        ? `${converted.clamped} inferred position${converted.clamped === 1 ? '' : 's'} clamped to the playable bed.`
        : 'All inferred positions are inside the playable bed.';
      ui.legend.replaceChildren(...converted.layout.map((ball) => {
        const row = document.createElement('div');
        row.textContent = ball.id === 0
          ? `cue ← Railbird ${ball.railbirdId}`
          : `${ball.id}-ball alias ← Railbird ${ball.railbirdId}`;
        return row;
      }));
      ui.prev.disabled = index === 0;
      ui.next.disabled = index === shots.length - 1;
      Object.assign(diagnostic, {
        state: 'ready', selected: index, shotId: shot.id,
        aliases: converted.layout.map((b) => [b.railbirdId, b.id]),
        clamped: converted.clamped,
        layout: converted.layout.map((b) => ({ ...b, source: { ...b.source } })),
        error: null,
      });
      if (history) {
        const url = new URL(location.href);
        url.searchParams.set('shot', String(index));
        window.history.replaceState(null, '', url);
      }
    };

    ui.prev.addEventListener('click', () => select(diagnostic.selected - 1));
    ui.next.addEventListener('click', () => select(diagnostic.selected + 1));
    window.addEventListener('popstate', () => {
      select(new URLSearchParams(location.search).get('shot') ?? 0, { history: false });
    });
    select(initialShot);
  } catch (error) {
    game.shoot = originalShoot;
    diagnostic.state = 'error';
    diagnostic.error = String(error?.message ?? error);
    ui.status.textContent = diagnostic.error;
    ui.panel.classList.add('ob-rb-error');
    reportError?.(`Railbird viewer: ${diagnostic.error}`);
  }
  return window.__railbird;
}
