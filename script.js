/* ============================================================
   Account Analyser - Tribal Wars (br140)
   v1.0.0
   ------------------------------------------------------------
   Lista todas as aldeias com:
     - Pontuação
     - Armazém (capacidade) e data/hora que ficará cheio
     - Fazenda (capacidade de população e % ocupado)
     - Construção (data/hora da última construção/demolição na fila)
     - Recrutamento por edifício (Quartel, Estábulo, Oficina)
   Permite ordenar por qualquer coluna e filtrar por grupo dinâmico.

   Padrão de requisições (igual aos outros scripts da suite):
     1) overview_villages&mode=prod   -> lista de aldeias (id, nome)
     2) overview_villages&mode=groups&type=dynamic -> grupos
     3) por aldeia, sequencial com delay de 300ms:
          screen=overview -> produção/recursos (regex) + game_data (JSON)
          screen=main     -> fila de construção/demolição
          screen=train    -> filas de recrutamento (quartel/estábulo/oficina)

   v1.0.0: primeira versão.
============================================================ */
(function () {
  'use strict';

  const PANEL_ID = 'aa-panel';
  $('#' + PANEL_ID).remove();

  const colors = {
    bg: '#e3d2a6',
    border: '#c8a45e',
    headerBg: '#4a2500',
    headerText: '#ffdd66',
    rowAlt: '#ead9ae',
    text: '#3a2a14'
  };

  const villageUrl = (id, screen, extra) =>
    `game.php?village=${id}&screen=${screen}${extra ? '&' + extra : ''}`;

  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Extrai um campo numérico simples de dentro do game_data via regex,
  // útil pra wood_prod/stone_prod/iron_prod/wood/stone/iron (decimais).
  function extractFloat(html, key) {
    const m = html.match(new RegExp('"' + key + '":"?([\\d.]+)"?'));
    return m ? parseFloat(m[1]) : 0;
  }

  // Extrai o bloco "var game_data = {...};" inteiro fazendo contagem de
  // chaves (regex simples não funciona porque o objeto é profundamente
  // aninhado). Retorna o objeto já parseado via JSON.parse, ou null.
  function extractGameData(html) {
    const idx = html.indexOf('var game_data');
    if (idx === -1) return null;
    const start = html.indexOf('{', idx);
    if (start === -1) return null;
    let depth = 0, i = start;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    const raw = html.slice(start, i);
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // Texto de data do jogo ("hoje às HH:MM:SS", "amanhã às HH:MM:SS",
  // "dd/mm/aa às HH:MM:SS") -> Date absoluto, pra permitir ordenação.
  function parseGameDateText(text, ref) {
    const t = text.trim();
    let m;
    if ((m = t.match(/^hoje às (\d{1,2}):(\d{2}):(\d{2})$/i))) {
      const d = new Date(ref);
      d.setHours(+m[1], +m[2], +m[3], 0);
      return d;
    }
    if ((m = t.match(/^amanhã às (\d{1,2}):(\d{2}):(\d{2})$/i))) {
      const d = new Date(ref);
      d.setDate(d.getDate() + 1);
      d.setHours(+m[1], +m[2], +m[3], 0);
      return d;
    }
    if ((m = t.match(/^(\d{1,2})[./](\d{1,2})[./]?(\d{2,4})?\s*às\s*(\d{1,2}):(\d{2}):(\d{2})$/i))) {
      const day = +m[1], month = +m[2] - 1;
      let year = m[3] ? +m[3] : ref.getFullYear();
      if (year < 100) year += 2000;
      return new Date(year, month, day, +m[4], +m[5], +m[6], 0);
    }
    return null;
  }

  function formatDate(d) {
    if (!d) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${dd}/${mm} ${hh}:${mi}:${ss}`;
  }

  const DATE_RE = /^(hoje às|amanhã às|\d{1,2}[./]\d{1,2}[./]?(\d{2,4})?\s*às)\s*\d{1,2}:\d{2}:\d{2}$/i;

  // Pega o último <td> (em ordem do DOM) dentro de um container cujo texto
  // bate com o padrão de data do jogo. Serve tanto pra fila de construção
  // quanto pra filas de recrutamento.
  function lastQueueDate(container, ref) {
    if (!container) return null;
    const tds = container.querySelectorAll('td');
    let lastText = null;
    tds.forEach(td => {
      const txt = td.textContent.trim();
      if (DATE_RE.test(txt)) lastText = txt;
    });
    return lastText ? parseGameDateText(lastText, ref) : null;
  }

  function parseVillageList(html) {
    const doc = parseDoc(html);
    const list = [];
    doc.querySelectorAll('span.quickedit-vn').forEach(el => {
      const id = el.getAttribute('data-id');
      const name = el.textContent.trim();
      if (id && name) list.push({ id: String(id), name });
    });
    return list;
  }

  function parseGroupList(html) {
    const doc = parseDoc(html);
    const groups = [];
    doc.querySelectorAll('span.quickedit-group').forEach(el => {
      const id = el.getAttribute('data-id');
      const nameEl = el.querySelector('span.quickedit-label');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (id && name) groups.push({ id: String(id), name });
    });
    return groups;
  }

  // ---------- UI ----------
  const $panel = $(`
    <div id="${PANEL_ID}" style="
      position:fixed; top:5%; left:50%; transform:translateX(-50%);
      width:95%; max-width:1300px; max-height:88vh; overflow:auto;
      background:${colors.bg}; border:2px solid ${colors.border};
      border-radius:6px; box-shadow:0 4px 18px rgba(0,0,0,0.5);
      z-index:99999; font-family:Verdana, Arial, sans-serif; font-size:12px;
      color:${colors.text};
    ">
      <div style="background:${colors.headerBg}; color:${colors.headerText}; padding:8px 12px;
                  display:flex; justify-content:space-between; align-items:center;
                  text-shadow:1px 1px 2px #000;">
        <strong>Account Analyser</strong>
        <span id="aa-close" style="cursor:pointer; font-weight:bold;">✕</span>
      </div>
      <div style="padding:8px 12px; border-bottom:1px solid ${colors.border}; display:flex; gap:8px; align-items:center;">
        <select id="aa-filter-group" style="flex:1; padding:4px 6px; border:1px solid ${colors.border}; border-radius:3px;">
          <option value="">Todas as aldeias</option>
        </select>
        <span id="aa-status" style="white-space:nowrap;">Carregando...</span>
      </div>
      <div style="overflow:auto;">
        <table id="aa-table" class="vis" style="width:100%; border-collapse:collapse;">
          <thead>
            <tr id="aa-head"></tr>
          </thead>
          <tbody id="aa-body"></tbody>
        </table>
      </div>
    </div>
  `).appendTo('body');

  $('#aa-close').on('click', () => $panel.remove());

  const COLUMNS = [
    { key: 'name',        label: 'Aldeia' },
    { key: 'points',      label: 'Pontuação' },
    { key: 'storage',     label: 'Armazém' },
    { key: 'storageFull',  label: 'Armazém cheio' },
    { key: 'farm',        label: 'Fazenda' },
    { key: 'build',       label: 'Construção' },
    { key: 'barracks',    label: 'Quartel' },
    { key: 'stable',      label: 'Estábulo' },
    { key: 'garage',      label: 'Oficina' }
  ];

  const $head = $('#aa-head');
  COLUMNS.forEach(col => {
    $head.append(`
      <th data-key="${col.key}" style="
        border:1px solid ${colors.border}; padding:5px 8px; cursor:pointer;
        background:${colors.headerBg}; color:${colors.headerText};
        white-space:nowrap; text-shadow:1px 1px 2px #000;
      ">${col.label} <span class="aa-arrow"></span></th>
    `);
  });

  let villages = [];      // dados completos (carregados)
  let groupFilterIds = null; // null = sem filtro
  let sortKey = 'name';
  let sortAsc = true;

  function setStatus(text) { $('#aa-status').text(text); }

  function renderTable() {
    const $body = $('#aa-body').empty();
    let rows = villages.slice();

    if (groupFilterIds) rows = rows.filter(v => groupFilterIds.has(v.id));

    rows.sort((a, b) => {
      let av = a.sort[sortKey], bv = b.sort[sortKey];
      if (av == null) av = sortAsc ? Infinity : -Infinity;
      if (bv == null) bv = sortAsc ? Infinity : -Infinity;
      if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? av - bv : bv - av;
    });

    rows.forEach((v, i) => {
      const bg = i % 2 ? colors.rowAlt : colors.bg;
      $body.append(`
        <tr style="background:${bg};">
          <td style="border:1px solid ${colors.border}; padding:4px 8px;">
            <a href="${villageUrl(v.id, 'main')}" style="color:${colors.text}; text-decoration:underline;">${escapeHtml(v.name)}</a>
          </td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px; text-align:right;">${v.display.points}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px; text-align:right;">${v.display.storage}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px;">${v.display.storageFull}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px; text-align:right;">${v.display.farm}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px;">${v.display.build}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px;">${v.display.barracks}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px;">${v.display.stable}</td>
          <td style="border:1px solid ${colors.border}; padding:4px 8px;">${v.display.garage}</td>
        </tr>
      `);
    });

    $head.find('th .aa-arrow').text('');
    $head.find(`th[data-key="${sortKey}"] .aa-arrow`).text(sortAsc ? '▲' : '▼');
  }

  $head.on('click', 'th', function () {
    const key = $(this).data('key');
    if (sortKey === key) sortAsc = !sortAsc; else { sortKey = key; sortAsc = true; }
    renderTable();
  });

  function loadGroups() {
    $.get(villageUrl(game_data.village.id, 'overview_villages', 'mode=groups&type=dynamic'), html => {
      parseGroupList(html).forEach(g => {
        $('#aa-filter-group').append(`<option value="${g.id}">${escapeHtml(g.name)}</option>`);
      });
    }).fail(() => console.warn('[AccountAnalyser] Falha ao carregar grupos.'));
  }

  $('#aa-filter-group').on('change', function () {
    const gid = $(this).val();
    if (!gid) { groupFilterIds = null; renderTable(); return; }
    setStatus('Filtrando grupo...');
    $.get(villageUrl(game_data.village.id, 'overview_villages', `mode=prod&group=${gid}`), html => {
      const ids = parseVillageList(html).map(v => v.id);
      groupFilterIds = new Set(ids);
      renderTable();
      setStatus(`${villages.filter(v => groupFilterIds.has(v.id)).length} aldeia(s) no grupo.`);
    }).fail(() => setStatus('Falha ao filtrar grupo.'));
  });

  // ---------- Carregamento principal ----------
  async function main() {
    setStatus('Carregando lista de aldeias...');
    const listHtml = await $.get(villageUrl(game_data.village.id, 'overview_villages', 'mode=prod'));
    const baseList = parseVillageList(listHtml);

    villages = baseList.map(v => ({
      id: v.id, name: v.name,
      sort: {}, display: {
        points: '...', storage: '...', storageFull: '...',
        farm: '...', build: '...', barracks: '...', stable: '...', garage: '...'
      }
    }));
    renderTable();
    loadGroups();

    const now = new Date();

    for (let i = 0; i < villages.length; i++) {
      const v = villages[i];
      setStatus(`Lendo aldeia ${i + 1} de ${villages.length}...`);

      try {
        // --- 1) screen=overview: produção, recursos atuais, dados gerais ---
        const ovHtml = await $.get(villageUrl(v.id, 'overview'));
        const gd = extractGameData(ovHtml);

        const rateWood = extractFloat(ovHtml, 'wood_prod') * 3600;
        const rateStone = extractFloat(ovHtml, 'stone_prod') * 3600;
        const rateIron = extractFloat(ovHtml, 'iron_prod') * 3600;
        const curWood = extractFloat(ovHtml, 'wood');
        const curStone = extractFloat(ovHtml, 'stone');
        const curIron = extractFloat(ovHtml, 'iron');

        const points = gd ? +gd.village.points : null;
        const storageMax = gd ? +gd.village.storage_max : null;
        const popMax = gd ? +gd.village.pop_max : null;
        const pop = gd ? +gd.village.pop : null;
        const storageLevel = gd && gd.village.buildings ? gd.village.buildings.storage : null;

        const timeFor = (cur, rate) => rate > 0 ? Math.max(0, storageMax - cur) / rate * 3600 : Infinity;
        const timeSec = Math.min(timeFor(curWood, rateWood), timeFor(curStone, rateStone), timeFor(curIron, rateIron));
        const fullAt = isFinite(timeSec) ? new Date(now.getTime() + timeSec * 1000) : null;

        v.sort.points = points;
        v.sort.storage = storageMax;
        v.sort.storageFull = fullAt ? fullAt.getTime() : Infinity;
        v.sort.farm = popMax > 0 ? pop / popMax : 0;

        v.display.points = points != null ? points.toLocaleString('pt-BR') : '?';
        v.display.storage = storageMax != null
          ? `${storageMax.toLocaleString('pt-BR')}${storageLevel != null ? ' (Nível ' + storageLevel + ')' : ''}`
          : '?';
        v.display.storageFull = fullAt ? formatDate(fullAt) : 'Cheio/—';
        v.display.farm = (popMax != null && pop != null)
          ? `${pop.toLocaleString('pt-BR')}/${popMax.toLocaleString('pt-BR')} (${Math.round(pop / popMax * 100)}%)`
          : '?';

        // --- 2) screen=main: fila de construção/demolição ---
        const mainHtml = await $.get(villageUrl(v.id, 'main'));
        const mainDoc = parseDoc(mainHtml);
        const buildQueue = mainDoc.querySelector('#buildqueue');
        const buildDate = lastQueueDate(buildQueue, now);
        v.sort.build = buildDate ? buildDate.getTime() : Infinity;
        v.display.build = buildDate ? formatDate(buildDate) : 'Livre';

        // --- 3) screen=train: filas de recrutamento por edifício ---
        const trainHtml = await $.get(villageUrl(v.id, 'train'));
        const trainDoc = parseDoc(trainHtml);
        ['barracks', 'stable', 'garage'].forEach(key => {
          const wrap = trainDoc.querySelector(`[id^="trainqueue_wrap_${key}"]`);
          const d = lastQueueDate(wrap, now);
          v.sort[key] = d ? d.getTime() : Infinity;
          v.display[key] = d ? formatDate(d) : 'Livre';
        });

      } catch (e) {
        console.error('[AccountAnalyser] Falha lendo aldeia', v.id, e);
        Object.keys(v.display).forEach(k => { if (v.display[k] === '...') v.display[k] = 'Erro'; });
      }

      renderTable();
      await sleep(300);
    }

    setStatus(`${villages.length} aldeia(s) carregada(s).`);
  }

  main();
})();
