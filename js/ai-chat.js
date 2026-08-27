    /* ===================================================================
       AI assistant — sidebar wiring + API calls
       =================================================================== */
    (function aiModule() {
      var T = window.t || function (s, p) { return p ? s.replace(/\{(\w+)\}/g, function (m, k) { return k in p ? p[k] : m; }) : s; };
      const LS_KEY_ANTHROPIC = 'md_anthropic_key';   // BYOK: brukerens egen Anthropic-nøkkel
      // Multi-provider-runden 2026-08-27. Egen leverandør = {type, base_url,
      // model} + nøkkel; kvalitet = fast|balanced|best. Lagres i klartekst i
      // localStorage, akkurat som Anthropic-nøkkelen over — bevisst: appen har
      // ingen konto å kryptere mot, og js/keys.js (askstats nøkkellager) er
      // sammenvevd med å injisere kildenøkler i BRUKERSKRIPT, som microdata
      // ikke gjør og ikke skal begynne med.
      const LS_KEY_PROVIDER = 'md_llm_provider';
      const LS_KEY_LLM = 'md_llm_key';
      const LS_KEY_QUALITY = 'md_ai_quality';
      // Skjult kraftbruker-vei (ingen UI, samme konvensjon som md_ai_autorun):
      //   localStorage.setItem('md_access_token', '<delt passord>')
      // Serverens M2PY_ACCESS_TOKEN har alltid vært implementert i auth.ts,
      // men hadde ingen klientvei i det hele tatt — data-loader.js sin
      // authToken-parameter hadde ingen kaller. Nå har den én.
      const LS_KEY_ACCESS = 'md_access_token';

      // key(<literal>) i scriptet er en hemmelighet — maskeres før scriptet
      // sendes til AI-endepunkter (spec 2026-07-05 §5). key(ask) beholdes.
      function scrubScript(s) {
        return (window.DataDirectives && window.DataDirectives.scrubKeys)
          ? window.DataDirectives.scrubKeys(s || '') : (s || '');
      }

      const state = {
        sending: false,
        history: [],   // {role, html|text, raw}
        get anthropicKey() { return localStorage.getItem(LS_KEY_ANTHROPIC) || ''; },
        get llmKey() { return lsGet(LS_KEY_LLM); },
        get accessToken() { return lsGet(LS_KEY_ACCESS); },
      };

      function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }

      /** {type, base_url, model} eller null. Korrupt JSON → null (ignoreres). */
      function providerConfig() {
        var raw = lsGet(LS_KEY_PROVIDER);
        if (!raw) return null;
        var p = null;
        try { p = JSON.parse(raw); } catch (e) { return null; }
        return (p && p.type && p.base_url && p.model) ? p : null;
      }

      /** En egen leverandør teller bare når BÅDE config og nøkkel foreligger. */
      function customProviderReady() { return !!(providerConfig() && state.llmKey); }

      function aiQuality() {
        var q = lsGet(LS_KEY_QUALITY);
        return (q === 'fast' || q === 'balanced' || q === 'best') ? q : 'balanced';
      }

      /**
       * Har brukeren i det hele tatt legitimasjon? Tre veier gir tilgang:
       * egen leverandør, egen Anthropic-nøkkel, eller det skjulte
       * tilgangspassordet. Alle knappe-portene bruker denne — aldri
       * state.anthropicKey direkte, ellers ville en leverandørbruker sett
       * knappene som deaktiverte.
       */
      function hasAiCredentials() {
        return customProviderReady() || !!state.anthropicKey || !!state.accessToken;
      }

      function cacheDom() {
        ['aiToggleBtn','aiSidebar','aiCloseBtn','aiSettingsBtn','aiClearBtn',
         'aiThread','aiInput','aiSendFastBtn','aiAbortBtn',
         'aiIncludeScript',
         'aiSettingsBackdrop','aiCfgAnthropicKey','aiCfgSave','aiCfgCancel',
         'aiCfgByokStored','aiCfgByokRemove',
         'aiCfgProviderType','aiCfgAnthropicSection','aiCfgProviderFields',
         'aiCfgProviderUrl','aiCfgProviderModel','aiCfgLlmKey','aiCfgQuality','aiCfgInstructions',
         'sidebarRight','sidebarOpenTab','scriptInput'
        ].forEach(id => { dom[id] = $(id); });
        dom.containers = document.querySelectorAll('.container');
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
          '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
      }

      function setOpen(open) {
        if (open) {
          // Mutually exclusive with Datasett sidebar
          if (dom.sidebarRight && !dom.sidebarRight.classList.contains('collapsed')) {
            dom.sidebarRight.classList.add('collapsed');
            dom.containers.forEach(c => c.classList.remove('sidebar-open'));
          }
          // Always make sure the Datasett open-tab is reachable; the original
          // code uses a `.hidden` class to hide it while Datasett is open.
          if (dom.sidebarOpenTab) dom.sidebarOpenTab.classList.remove('hidden');
          dom.aiSidebar.classList.add('open');
          dom.aiSidebar.setAttribute('aria-hidden', 'false');
          dom.containers.forEach(c => c.classList.add('ai-open'));
          dom.aiToggleBtn.classList.add('active');
          if (state.history.length === 0) renderEmpty();
          setTimeout(() => dom.aiInput.focus(), 60);
        } else {
          dom.aiSidebar.classList.remove('open');
          dom.aiSidebar.setAttribute('aria-hidden', 'true');
          dom.containers.forEach(c => c.classList.remove('ai-open'));
          dom.aiToggleBtn.classList.remove('active');
          // Make sure the Datasett tab is reachable after the AI panel goes away.
          if (dom.sidebarOpenTab && dom.sidebarRight && dom.sidebarRight.classList.contains('collapsed')) {
            dom.sidebarOpenTab.classList.remove('hidden');
          }
        }
      }
      function toggleOpen() { setOpen(!dom.aiSidebar.classList.contains('open')); }

      function renderEmpty() {
        dom.aiThread.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'ai-empty';
        wrap.innerHTML = '<div class="ai-empty-title">' + T('Hei! Hva kan jeg hjelpe med?') + '</div>' +
          '<div>' + T('Spør om en analyse, et skript, eller hva en kommando gjør.') + '</div>' +
          '<div class="ai-empty-examples">' +
            '<button type="button" class="ai-empty-example" data-q="' + T('Vis sammendragsstatistikk for inntekt og kjønn') + '">' + T('Vis sammendragsstatistikk for inntekt og kjønn') + '</button>' +
            '<button type="button" class="ai-empty-example" data-q="What does reshape long do?">What does reshape long do?</button>' +
            '<button type="button" class="ai-empty-example" data-q="' + T('Hvilke variabler finnes for utdanning?') + '">' + T('Hvilke variabler finnes for utdanning?') + '</button>' +
          '</div>';
        dom.aiThread.appendChild(wrap);
        wrap.querySelectorAll('.ai-empty-example').forEach(btn => {
          btn.addEventListener('click', () => {
            dom.aiInput.value = btn.dataset.q;
            autoresize();
            sendSvarMessage();
          });
        });
      }

      function appendUserMessage(text) {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg ai-msg-user';
        wrap.innerHTML = '<div class="ai-bubble"></div>';
        wrap.querySelector('.ai-bubble').textContent = text;
        dom.aiThread.appendChild(wrap);
        scrollToBottom();
      }

      function appendThinking() {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg ai-msg-assistant';
        wrap.innerHTML = '<div class="ai-thinking"><span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span><span style="margin-left:4px">' + T('Tenker…') + '</span></div>';
        dom.aiThread.appendChild(wrap);
        scrollToBottom();
        return wrap;
      }

      function appendError(node, msg) {
        node.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'ai-error';
        err.textContent = msg;
        node.appendChild(err);
        scrollToBottom();
      }

      function appendAssistantText(node, text, meta) {
        node.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        bubble.innerHTML = md ? md.render(text || '') : escapeHtml(text || '').replace(/\n/g, '<br>');
        bubble._rawMd = text || '';
        node.appendChild(bubble);
        if (meta) appendMeta(node, meta);
        attachCodeBlockActions(bubble);
        attachResponseInsertBar(node, text || '');
        scrollToBottom();
      }

      function appendAssistantScript(node, script, rationale, meta) {
        node.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        if (rationale) {
          const rationaleHtml = md ? md.render(rationale) : '<p>' + escapeHtml(rationale) + '</p>';
          bubble.innerHTML += rationaleHtml;
        }
        // Custom code-block markup with action buttons
        const cbWrap = document.createElement('div');
        cbWrap.className = 'ai-codeblock-wrap';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = script;
        pre.appendChild(code);
        cbWrap.appendChild(pre);
        const actions = document.createElement('div');
        actions.className = 'ai-codeblock-actions';
        actions.innerHTML =
          '<button type="button" class="ai-codeblock-btn" data-act="copy">📋 ' + T('Kopier') + '</button>';
        cbWrap.appendChild(actions);
        bubble.appendChild(cbWrap);
        actions.addEventListener('click', (e) => {
          const btn = e.target.closest('.ai-codeblock-btn');
          if (!btn) return;
          handleCodeAction(btn.dataset.act, script, btn);
        });
        // Validation warnings (unknown variables / commands / parse errors)
        const warning = renderValidationWarnings(meta && meta.validation);
        if (warning) bubble.appendChild(warning);
        node.appendChild(bubble);
        if (meta) appendMeta(node, meta);
        // Response-level "Sett inn" bar (synthesize markdown from rationale + code)
        const rawMd = (rationale ? rationale + '\n\n' : '') + '```microdata\n' + script + '\n```';
        bubble._rawMd = rawMd;
        attachResponseInsertBar(node, rawMd);
        scrollToBottom();
      }

      function renderValidationWarnings(validation) {
        if (!validation || validation.passed || !validation.errors || !validation.errors.length) {
          return null;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ai-validation-warning';
        const title = document.createElement('div');
        title.className = 'ai-validation-warning-title';
        title.textContent = T('⚠ Valideringsadvarsler');
        wrap.appendChild(title);

        const groups = { unknown_variable: [], unknown_command: [], parse: [], runtime: [], other: [] };
        for (const e of validation.errors) {
          const k = e.kind in groups ? e.kind : 'other';
          groups[k].push(e);
        }

        const renderChips = (label, errs, suggestionTemplate) => {
          if (!errs.length) return;
          const sec = document.createElement('div');
          sec.className = 'ai-validation-section';
          const lab = document.createElement('div');
          lab.className = 'ai-validation-section-label';
          lab.textContent = label;
          sec.appendChild(lab);
          const chips = document.createElement('div');
          chips.className = 'ai-validation-chips';
          errs.forEach(e => {
            const chip = document.createElement('span');
            chip.className = 'ai-chip';
            chip.textContent = e.token || e.message || '?';
            chip.title = T('{msg} — klikk for å foreslå alternativ', { msg: e.message || '' });
            chip.addEventListener('click', () => {
              if (!dom.aiInput) return;
              dom.aiInput.value = suggestionTemplate.replace('{token}', e.token || '');
              autoresize();
              dom.aiInput.focus();
            });
            chips.appendChild(chip);
          });
          sec.appendChild(chips);
          wrap.appendChild(sec);
        };

        renderChips(T('Ukjente variabler'), groups.unknown_variable, T('Bruk en annen variabel for {token}'));
        renderChips(T('Ukjente kommandoer'), groups.unknown_command, T('Skriv om uten å bruke {token}'));

        const others = [...groups.parse, ...groups.runtime, ...groups.other];
        if (others.length) {
          const sec = document.createElement('div');
          sec.className = 'ai-validation-section';
          const lab = document.createElement('div');
          lab.className = 'ai-validation-section-label';
          lab.textContent = T('Andre advarsler');
          sec.appendChild(lab);
          const ul = document.createElement('ul');
          ul.className = 'ai-validation-bullets';
          others.forEach(e => {
            const li = document.createElement('li');
            const lineHint = e.line_no ? T('linje {n}: ', { n: e.line_no }) : '';
            li.textContent = lineHint + (e.message || e.kind);
            ul.appendChild(li);
          });
          sec.appendChild(ul);
          wrap.appendChild(sec);
        }

        return wrap;
      }

      function appendAssistantVariableList(node, variables, meta) {
        node.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        if (!variables || !variables.length) {
          bubble.textContent = T('Ingen variabler funnet.');
        } else {
          const intro = document.createElement('p');
          intro.textContent = T('Fant {n} variabler:', { n: variables.length });
          bubble.appendChild(intro);
          const list = document.createElement('ul');
          list.style.margin = '0'; list.style.paddingLeft = '18px';
          variables.forEach(v => {
            const li = document.createElement('li');
            li.style.marginBottom = '4px';
            li.innerHTML = '<code>' + escapeHtml(v.name) + '</code> — ' + escapeHtml(v.short_title || '');
            list.appendChild(li);
          });
          bubble.appendChild(list);
        }
        node.appendChild(bubble);
        if (meta) appendMeta(node, meta);
        scrollToBottom();
      }

      function appendMeta(node, meta) {
        // Meta-linja (intent · modell · tid · tokens · cache) er støy for brukeren — vises ikke.
      }

      function commentize(text) {
        return String(text).split('\n').map(l => '// ' + l).join('\n');
      }

      // Build editor content from a full markdown response, preserving document
      // order ("legg de etter hverandre"). includeComments=false → only the code
      // blocks; true → prose rendered as // comments interleaved with the code.
      function buildInsertContent(rawMd, includeComments) {
        if (!rawMd) return '';
        const re = /```[^\n]*\r?\n([\s\S]*?)```/g;
        const parts = [];
        let last = 0, m;
        while ((m = re.exec(rawMd)) !== null) {
          if (includeComments) {
            const prose = rawMd.slice(last, m.index).trim();
            if (prose) parts.push(commentize(prose));
          }
          const code = (m[1] || '').replace(/\s+$/, '');
          if (code.trim()) parts.push(code);
          last = re.lastIndex;
        }
        if (includeComments) {
          const tail = rawMd.slice(last).trim();
          if (tail) parts.push(commentize(tail));
        }
        // No fenced code at all: comment the whole thing when asked, else nothing.
        if (parts.length === 0 && includeComments) {
          const all = rawMd.trim();
          if (all) parts.push(commentize(all));
        }
        return parts.join('\n\n');
      }

      function hasCodeBlock(rawMd) {
        return !!rawMd && /```[\s\S]*?```/.test(rawMd);
      }

      // Response-level action bar shown under the whole answer: an "include
      // explanation as comment" checkbox and a single "Sett inn" button that
      // replaces the editor content.
      function attachResponseInsertBar(node, rawMd) {
        if (!dom.scriptInput || !hasCodeBlock(rawMd)) return;
        const bar = document.createElement('div');
        bar.className = 'ai-response-actions';

        const lbl = document.createElement('label');
        lbl.className = 'ai-include-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + T('Inkluder forklaring som kommentar')));

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-response-insert-btn';
        btn.textContent = T('Sett inn');
        btn.title = T('Sett svaret inn i editoren (erstatter innholdet)');
        btn.addEventListener('click', () => {
          const content = buildInsertContent(rawMd, cb.checked);
          if (!content) return;
          dom.scriptInput.value = content;
          dom.scriptInput.dispatchEvent(new Event('input', { bubbles: true }));
          flash(btn, T('✓ Satt inn'));
        });

        // Knapp før checkbox (horisontalt).
        bar.appendChild(btn);
        bar.appendChild(lbl);
        node.appendChild(bar);
      }

      function handleCodeAction(act, script, btn) {
        if (act === 'copy') {
          navigator.clipboard.writeText(script).then(() => flash(btn, T('✓ Kopiert')));
        }
      }

      function flash(btn, label) {
        const original = btn.textContent;
        btn.textContent = label;
        btn.classList.add('flash');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('flash'); }, 1200);
      }

      function attachCodeBlockActions(bubble) {
        // For markdown-rendered code blocks, attach a small copy button
        bubble.querySelectorAll('pre').forEach(pre => {
          if (pre.parentElement.classList.contains('ai-codeblock-wrap')) return;
          const codeEl = pre.querySelector('code') || pre;
          const text = codeEl.textContent;
          if (!text || text.length < 12) return;
          const wrap = document.createElement('div');
          wrap.className = 'ai-codeblock-wrap';
          pre.parentElement.insertBefore(wrap, pre);
          wrap.appendChild(pre);
          const actions = document.createElement('div');
          actions.className = 'ai-codeblock-actions';
          actions.innerHTML =
            '<button type="button" class="ai-codeblock-btn" data-act="copy">📋 ' + T('Kopier') + '</button>';
          wrap.appendChild(actions);
          actions.addEventListener('click', (e) => {
            const btn = e.target.closest('.ai-codeblock-btn');
            if (!btn) return;
            handleCodeAction(btn.dataset.act, text, btn);
          });
        });
      }

      function scrollToBottom() {
        dom.aiThread.scrollTop = dom.aiThread.scrollHeight;
      }

      // Headers for edge-funksjonene (/api/*). Presedens, og den er bevisst:
      // egen leverandør > egen Anthropic-nøkkel > delt tilgangspassord.
      // Serversiden speiler dette (auth.ts: BYOK/llm-key slår Bearer-token).
      function edgeAuthHeaders() {
        const h = { 'Content-Type': 'application/json' };
        if (customProviderReady()) { h['X-Llm-Key'] = state.llmKey; return h; }
        if (state.anthropicKey) { h['X-Anthropic-Key'] = state.anthropicKey; return h; }
        if (state.accessToken) { h['Authorization'] = 'Bearer ' + state.accessToken; return h; }
        return h;
      }

      /**
       * Feltene hvert /api/*-kall skal bære. Ett sted, slik at et nytt
       * kallsted ikke kan glemme dem: uten `provider` faller serveren tilbake
       * til Anthropic, og uten `quality` til per-kallsted-defaulten.
       */
      function edgeBodyExtras() {
        return { provider: providerConfig() || undefined, quality: aiQuality() };
      }

      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      // Nett/HTTP-feil skal navngi endepunkt og fase (js/ai-transport.js);
      // brukerens egen Avbryt (AbortError) skal aldri pakkes inn.
      function rethrowDescribed(e, endpoint, phase, hop) {
        if (e && e.name === 'AbortError') throw e;
        throw new Error(AiTransport.describeError(e, { endpoint: endpoint, phase: phase, hop: hop }));
      }

      function streamRenderMd(bubble, textMd) {
        if (md) {
          try { bubble.innerHTML = md.render(textMd || ''); return; }
          catch (_) { /* fall through */ }
        }
        bubble.textContent = textMd || '';
      }

      async function runInterpretQuery(payload, thinkingNode, signal) {
        const headers = edgeAuthHeaders();
        const resp = await AiTransport.postWithRetry('/api/tolk-resultat', {
          method: 'POST',
          headers,
          body: JSON.stringify(Object.assign({
            script: payload.script || '',
            output: payload.output || '',
            språk: payload.lang || 'auto',
            ui_lang: (window.M2PY_LANG === 'en') ? 'en' : 'no',
          }, edgeBodyExtras())),
          signal,
        }).catch((e) => rethrowDescribed(e, 'tolk-resultat', 'request'));
        if (resp.status === 401) {
          throw new Error(T('Ugyldig API-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
        }
        if (!resp.ok || !resp.body) {
          throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        }
        thinkingNode.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        thinkingNode.appendChild(bubble);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', accumulated = '', _lastRender = 0;
        while (true) {
          const { value, done } = await reader.read().catch((e) => rethrowDescribed(e, 'tolk-resultat', 'stream'));
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj;
            try { obj = JSON.parse(dataLine.slice(5).trim()); } catch (_) { continue; }
            if (obj.type === 'text') {
              accumulated += obj.text;
              const _now = Date.now();
              if (_now - _lastRender > 70) {
                _lastRender = _now;
                streamRenderMd(bubble, accumulated);
                scrollToBottom();
              }
            } else if (obj.type === 'error') {
              throw new Error(obj.message || T('Ukjent feil fra server'));
            }
          }
        }
        if (md) {
          try { bubble.innerHTML = md.render(accumulated || ''); }
          catch (_) { bubble.textContent = accumulated; }
        } else {
          bubble.textContent = accumulated;
        }
        bubble._rawMd = accumulated;
        // Kopier-knapp for tolkningen.
        const actions = document.createElement('div');
        actions.className = 'ai-codeblock-actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ai-codeblock-btn';
        copyBtn.textContent = '📋 ' + T('Kopier tolkning');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(accumulated).then(() => flash(copyBtn, T('✓ Kopiert'))).catch(() => {});
        });
        actions.appendChild(copyBtn);
        thinkingNode.appendChild(actions);
        state.history.push({ role: 'assistant', meta: { intent: 'tolkning' } });
      }

      // ── Web mode: /api/data-svar (agentic web search + generation, admin-only) ──
      // SSE contract (netlify/edge-functions/data-svar.ts):
      //   {type:'progress', text, replace?}  — live tool-call/phase labels; replace:true
      //     means "update the previous replaceable line in place" (heartbeat ticks
      //     with a seconds counter while a long API turn is in flight)
      //   {type:'text', text}      — markdown chunks (explanation + one fenced script)
      //   {type:'sources', sources:[{url, ok, cors, viaProxy}]} — deterministic probe manifest
      //   {type:'continue', state, probed} — invocation's turn budget spent; re-POST
      //     with resume:{state, probed} to keep going (Netlify CPU cap per request)
      //   {type:'error', message}
      // Consume one SSE response, dispatching parsed events to onEvent. Mirrors the
      // inline reader-loopen i runInterpretQuery over
      // (not factored out into a shared helper there, to avoid touching working code);
      // this is the equivalent for the new Web-mode path.
      async function consumeSse(resp, onEvent) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj;
            try { obj = JSON.parse(dataLine.slice(5).trim()); }
            catch (_) { continue; }   // ignore non-JSON keep-alive lines
            onEvent(obj);
          }
        }
      }


      // ── Samlet pipeline: /api/svar — agentisk løp med run_code i emulatoren ──
      // (spec 2026-08-28). run_code-rundturen: server emitterer
      // {type:'run_code', script} + continue; vi setter scriptet SYNLIG inn i
      // editoren, kjører (første gang bak samme bekreftelse som før,
      // md_ai_autorun=1 hopper over), høster motor-side (mdRunHarvest) og
      // re-POSTer RunResult.format(...) i run_result. Byte-kontrakten
      // (OK./FEIL-prefiks) klassifiseres server-side av run-disiplin.ts.
      async function runSvar(question, thinkingNode, signal) {
        const t0 = Date.now();
        thinkingNode.innerHTML = '';
        const progressBox = document.createElement('div');
        progressBox.className = 'ai-progress';
        thinkingNode.appendChild(progressBox);
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        thinkingNode.appendChild(bubble);

        const em = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'microdata';
        const mode = (em === 'python' || em === 'r') ? em : 'microdata';
        let markdown = '';
        let _lastRender = 0;
        let resume = null;
        let runResult = null;
        let confirmed = false;
        const includeScript = dom.aiIncludeScript.checked && dom.scriptInput && dom.scriptInput.value.trim();

        function handleSvarEvent(ev) {
          if (ev.type === 'progress') {
            const last = progressBox.lastElementChild;
            if (ev.replace && last && last.dataset.replace === '1') {
              last.textContent = '⏳ ' + ev.text;
            } else {
              const line = document.createElement('div');
              line.className = 'ai-progress-line';
              if (ev.replace) line.dataset.replace = '1';
              line.textContent = (ev.text && (ev.text.startsWith('▶') || ev.text.startsWith('⚠️'))) ? ev.text : '⏳ ' + ev.text;
              progressBox.appendChild(line);
            }
            scrollToBottom();
          } else if (ev.type === 'text') {
            markdown += ev.text;
            const _now = Date.now();
            if (_now - _lastRender > 70) {
              _lastRender = _now;
              streamRenderMd(bubble, markdown);
              scrollToBottom();
            }
          } else if (ev.type === 'error') {
            let msg = ev.message || 'ukjent feil';
            // 401 fra oppstrøms betyr brukerens EGEN nøkkel er avvist —
            // uansett hvilken av de tre veiene som bar den.
            if (hasAiCredentials() &&
                (msg.indexOf('Anthropic API error 401') !== -1 || msg.indexOf('Leverandørfeil 401') !== -1)) {
              msg = T('Ugyldig API-nøkkel. Sjekk nøkkelen i AI-innstillingene.');
            }
            throw new Error(msg);
          }
        }

        for (let hop = 0; ; hop++) {
          if (hop > 40) throw new Error(T('Avbrutt: svaret ble ikke ferdig etter 40 fortsettelses-runder.'));
          const resp = await AiTransport.postWithRetry('/api/svar', {
            method: 'POST',
            headers: edgeAuthHeaders(),
            body: JSON.stringify(Object.assign({
              question,
              mode,
              script: includeScript ? scrubScript(dom.scriptInput.value) : undefined,
              instructions: lsGet('md_ai_instructions') || undefined,
              resume: resume || undefined,
              run_result: runResult == null ? undefined : runResult,
            }, edgeBodyExtras())),
            signal,
          }).catch((e) => rethrowDescribed(e, 'svar', 'request', hop));
          runResult = null;
          if (resp.status === 401) {
            throw new Error(T('Ugyldig API-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
          }
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));

          let cont = null, pendingRun = null;
          await consumeSse(resp, (ev) => {
            if (ev.type === 'continue') { cont = { state: ev.state, run_ok_calls: ev.run_ok_calls }; return; }
            if (ev.type === 'run_code') { pendingRun = ev.script || ''; return; }
            handleSvarEvent(ev);
          }).catch((e) => rethrowDescribed(e, 'svar', 'stream', hop));

          if (pendingRun != null) {
            if (signal && signal.aborted) {
              throw Object.assign(new Error('Stopped'), { name: 'AbortError' });
            }
            insertScriptIntoEditor(pendingRun);
            if (!confirmed) {
              const ok = await confirmAutoRun();
              if (!ok) {
                handleSvarEvent({ type: 'progress', text: T('Kjøring avslått — scriptet står i editoren.') });
                break;
              }
              confirmed = true;
            }
            handleSvarEvent({ type: 'progress', text: '▶ ' + T('Kjører scriptet i emulatoren …') });
            const err = await runScriptAndCaptureError();
            const h = (typeof window.mdRunHarvest === 'function') ? window.mdRunHarvest() : { ok: !err, output: err || '' };
            const res = (err || !h.ok) ? { ok: false, output: err || h.output } : h;
            runResult = RunResult.format(res);
            if (!res.ok) {
              // FEIL-linja (askstat-spec 2026-08-15 §1): kjørefeil skal være
              // synlige for MENNESKER i prosessloggen, ikke bare for modellen.
              const fl = String(res.output || '').split('\n')[0].slice(0, 160);
              if (fl) handleSvarEvent({ type: 'progress', text: '⚠️ ' + T('Kjøring feilet: ') + fl });
            }
            resume = cont;   // run_code ender alltid invokasjonen med en continue
            continue;
          }
          if (!cont) break;
          resume = cont;
        }

        streamRenderMd(bubble, markdown);
        attachCodeBlockActions(bubble);
        bubble._rawMd = markdown;
        attachResponseInsertBar(thinkingNode, markdown);
        return { markdown, latency: Date.now() - t0 };
      }

      // Send-flyten: legitimasjonsport, brukerboble, thinking-node, abort —
      // så hele svaret via runSvar.
      async function sendSvarMessage() {
        if (state.sending) return;
        const text = dom.aiInput.value.trim();
        if (!text) return;
        if (!hasAiCredentials()) {
          openSettings();
          return;
        }
        state.sending = true;
        if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = true;
        if (state.history.length === 0) dom.aiThread.innerHTML = '';
        appendUserMessage(text);
        state.history.push({ role: 'user', text });
        dom.aiInput.value = '';
        autoresize();
        const thinkingNode = appendThinking();
        const ctrl = new AbortController();
        state.abortCtrl = ctrl;
        if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = '';
        try {
          const meta = await runSvar(text, thinkingNode, ctrl.signal);
          state.history.push({ role: 'assistant', meta });
        } catch (e) {
          if (e.name !== 'AbortError') appendError(thinkingNode, '✗ ' + (e && e.message ? e.message : String(e)));
        } finally {
          state.abortCtrl = null;
          if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = 'none';
          state.sending = false;
          if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = false;
          dom.aiInput.focus();
        }
      }

      function insertScriptIntoEditor(script) {
        if (!dom.scriptInput) return;
        dom.scriptInput.value = script;
        dom.scriptInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Run the script currently in the editor via the SAME path the Kjør
      // button uses (index.html's btnRun click handler — it dispatches on
      // activeEditorMode, handles local/remote execution, and renders
      // output/errors into #outputArea). That handler has no return value or
      // promise of its own, so this is a v1 compromise: click the button, wait
      // for the run to settle via window.mdIsScriptRunning() (a one-line getter
      // exposed by index.html for exactly this purpose), then read the error
      // back out of #outputArea's `pre.error` node (also index.html's existing
      // error-rendering convention — see the catch-block in btnRun's handler).
      // Returns null on success, or the error text on failure.
      //
      // Staleness note (checked against index.html's btnRun handler): every
      // run path — the python/duckdb try/catch (renderOutput on success,
      // `pre.error` in the catch block) and R's runSelf -> runHybridR ->
      // renderROutputParts — rewrites #outputArea for THIS run before its own
      // `finally` flips scriptRunInProgress back to false. So whenever the
      // poll loop below observes mdIsScriptRunning() === false, #outputArea
      // already reflects this run's outcome, never a stale previous round's —
      // no pre-run snapshot of the error text is needed. That guarantee only
      // covers the "settled" case, though: if we hit the 180s ceiling while
      // mdIsScriptRunning() is still true, the run handler hasn't written
      // anything for this run yet, so #outputArea may still hold the previous
      // round's error. In that case we return a distinct, honest timeout
      // message instead of reading `.error` — this ends the repair loop as a
      // failure and leaves the script in the editor, rather than reporting a
      // false success or feeding a stale error into the next repair round.
      async function runScriptAndCaptureError() {
        const btn = document.getElementById('btnRun');
        const outputArea = document.getElementById('outputArea');
        if (!btn) return T('Fant ikke Kjør-knappen.');
        if (typeof window.mdIsScriptRunning !== 'function') {
          return T('Kan ikke sjekke kjørestatus (mdIsScriptRunning mangler).');
        }
        let waited = 0;
        // B7 (docs/REVIEW_2026-07-07.md §3): waiting on btn.disabled alone is
        // not enough — during an active run the button stays ENABLED but
        // relabeled "Avbryt", so a click would call performRunInterrupt() on
        // the user's own run instead of starting ours, and the repair loop
        // would then misread the aborted run's error as our script's error.
        // Wait for BOTH pyodide-ready (btn no longer disabled-for-loading)
        // AND no run already in progress; give up loudly (return an error
        // string, never click) if that doesn't happen within the timeout.
        while ((btn.disabled || window.mdIsScriptRunning()) && waited < 20000) {
          await sleep(200); waited += 200;
        }
        if (btn.disabled) return T('Kjør-knappen er ikke klar (miljøet laster fortsatt).');
        if (window.mdIsScriptRunning()) {
          return T('Kan ikke starte automatisk kjøring — en annen kjøring pågår allerede.');
        }
        btn.click();
        await sleep(50);   // let the click handler's async body flip the running flag
        const start = Date.now();
        while (window.mdIsScriptRunning() && Date.now() - start < 180000) {
          await sleep(150);
        }
        if (window.mdIsScriptRunning()) {
          return T('Kjøringen var ikke ferdig etter 180 sekunder — overvåking avbrutt.');
        }
        const errEl = outputArea && outputArea.querySelector('pre.error');
        return errEl ? errEl.textContent : null;
      }

      // S2 (docs/REVIEW_2026-07-07.md §3): Web-mode answers can contain a
      // prompt-injected script (the /api/data-svar backend does agentic web
      // search — a poisoned page can inject arbitrary instructions), and the
      // app runs it in main-thread Pyodide alongside localStorage secrets
      // (GitHub PAT, API keys). The script is still auto-inserted into the
      // editor, but the FIRST run of an answer must be user-initiated. This
      // renders a small inline confirmation bubble styled like the existing
      // chat action buttons (attachResponseInsertBar's ai-response-actions /
      // ai-response-insert-btn, and ai-codeblock-btn for the secondary
      // action) and resolves true/false on Kjør/Avbryt.
      //
      // Power-user opt-out (no settings UI by design — set directly):
      //   localStorage.setItem('md_ai_autorun', '1')
      // skips this confirmation entirely and auto-runs immediately, same as
      // before S2. Anyone flipping this on has explicitly opted into the risk.
      function getAutorunPref() {
        try { return localStorage.getItem('md_ai_autorun') === '1'; } catch (e) { return false; }
      }
      function confirmAutoRun() {
        if (getAutorunPref()) return Promise.resolve(true);
        return new Promise(function (resolve) {
          const wrap = document.createElement('div');
          wrap.className = 'ai-msg ai-msg-assistant';
          wrap.innerHTML = '<div class="ai-bubble"></div>';
          const bubble = wrap.querySelector('.ai-bubble');
          const question = document.createElement('div');
          question.textContent = T('Kjør det genererte scriptet?');
          bubble.appendChild(question);
          const bar = document.createElement('div');
          bar.className = 'ai-response-actions';
          const runBtn = document.createElement('button');
          runBtn.type = 'button';
          runBtn.className = 'ai-response-insert-btn';
          runBtn.textContent = T('Kjør');
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'ai-codeblock-btn';
          cancelBtn.textContent = T('Avbryt');
          bar.appendChild(runBtn);
          bar.appendChild(cancelBtn);
          bubble.appendChild(bar);
          dom.aiThread.appendChild(wrap);
          scrollToBottom();
          function settle(ok) {
            runBtn.disabled = true;
            cancelBtn.disabled = true;
            bar.remove();
            const status = document.createElement('div');
            status.className = 'ai-repair-note';
            status.textContent = ok ? T('✓ Kjører …') : T('Avbrutt — scriptet står i editoren.');
            bubble.appendChild(status);
            resolve(ok);
          }
          runBtn.addEventListener('click', function () { settle(true); });
          cancelBtn.addEventListener('click', function () { settle(false); });
        });
      }

      function autoresize() {
        const ta = dom.aiInput;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';  // ~5 linjer maks, så scroller den
      }

      function refreshUserPanel() {
        if (dom.aiCfgByokStored) {
          dom.aiCfgByokStored.style.display = (state.anthropicKey || state.accessToken) ? '' : 'none';
        }
        if (window.mdSyncWebBtnVisibility) window.mdSyncWebBtnVisibility();
      }

      // Presets er BARE bekvemmelighet — de tre TYPENE er kontrakten, og en
      // leverandør som ikke står her nås fortsatt via «Annen» + egen URL.
      // Ingen vendor-liste å vedlikeholde: openai-compat er protokollen så å
      // si alle implementerer.
      const PROVIDER_PRESETS = [
        { id: 'anthropic',  label: 'Anthropic',                  type: null },
        { id: 'openai',     label: 'OpenAI',                     type: 'openai-responses', url: 'https://api.openai.com/v1',        model: 'gpt-5.6' },
        { id: 'mistral',    label: 'Mistral',                    type: 'openai-compat',    url: 'https://api.mistral.ai/v1',        model: 'mistral-large-latest' },
        { id: 'groq',       label: 'Groq',                       type: 'openai-compat',    url: 'https://api.groq.com/openai/v1',   model: '' },
        { id: 'deepseek',   label: 'DeepSeek',                   type: 'openai-compat',    url: 'https://api.deepseek.com/v1',      model: 'deepseek-chat' },
        { id: 'openrouter', label: 'OpenRouter',                 type: 'openai-compat',    url: 'https://openrouter.ai/api/v1',     model: '' },
        { id: 'anthropic-gw', label: 'Anthropic-kompatibel gateway', type: 'anthropic-compat', url: '',                             model: '' },
        { id: 'other',      label: 'Annen (OpenAI-kompatibel)',  type: 'openai-compat',    url: '',                                 model: '' }
      ];
      function presetById(id) {
        for (var i = 0; i < PROVIDER_PRESETS.length; i++) {
          if (PROVIDER_PRESETS[i].id === id) return PROVIDER_PRESETS[i];
        }
        return PROVIDER_PRESETS[0];
      }
      /** Hvilket preset svarer til lagret config? Matcher på type+URL. */
      function presetForConfig(cfg) {
        if (!cfg) return PROVIDER_PRESETS[0];
        for (var i = 1; i < PROVIDER_PRESETS.length; i++) {
          var pr = PROVIDER_PRESETS[i];
          if (pr.type === cfg.type && pr.url && pr.url === cfg.base_url) return pr;
        }
        for (var j = 1; j < PROVIDER_PRESETS.length; j++) {
          if (PROVIDER_PRESETS[j].type === cfg.type && !PROVIDER_PRESETS[j].url) return PROVIDER_PRESETS[j];
        }
        return PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
      }

      function fillProviderSelect() {
        var sel = dom.aiCfgProviderType;
        if (!sel || sel.options.length) return;
        for (var i = 0; i < PROVIDER_PRESETS.length; i++) {
          var o = document.createElement('option');
          o.value = PROVIDER_PRESETS[i].id;
          o.textContent = PROVIDER_PRESETS[i].label;
          sel.appendChild(o);
        }
      }

      /** Vis Anthropic-feltet ELLER de tre leverandørfeltene, aldri begge. */
      function syncProviderFields() {
        var isAnthropic = !dom.aiCfgProviderType || dom.aiCfgProviderType.value === 'anthropic';
        if (dom.aiCfgAnthropicSection) dom.aiCfgAnthropicSection.style.display = isAnthropic ? '' : 'none';
        if (dom.aiCfgProviderFields) dom.aiCfgProviderFields.style.display = isAnthropic ? 'none' : '';
      }

      function openSettings() {
        fillProviderSelect();
        if (dom.aiCfgAnthropicKey) dom.aiCfgAnthropicKey.value = state.anthropicKey || state.accessToken;
        var cfg = providerConfig();
        var pr = presetForConfig(cfg);
        if (dom.aiCfgProviderType) dom.aiCfgProviderType.value = pr.id;
        if (dom.aiCfgProviderUrl) dom.aiCfgProviderUrl.value = cfg ? cfg.base_url : (pr.url || '');
        if (dom.aiCfgProviderModel) dom.aiCfgProviderModel.value = cfg ? cfg.model : (pr.model || '');
        if (dom.aiCfgLlmKey) dom.aiCfgLlmKey.value = state.llmKey;
        if (dom.aiCfgQuality) dom.aiCfgQuality.value = aiQuality();
        if (dom.aiCfgInstructions) dom.aiCfgInstructions.value = lsGet('md_ai_instructions');
        syncProviderFields();
        refreshUserPanel();
        dom.aiSettingsBackdrop.classList.add('open');
      }
      function closeSettings() { dom.aiSettingsBackdrop.classList.remove('open'); }
      function saveSettings() {
        // Ett felt, to slag legitimasjon. Den som IKKE ble skrevet inn
        // fjernes, ellers ville en gammel nøkkel fortsatt vunnet presedensen
        // i edgeAuthHeaders etter at brukeren byttet til passord.
        const entered = dom.aiCfgAnthropicKey ? dom.aiCfgAnthropicKey.value.trim() : '';
        const kind = window.AiCredential.classify(entered);
        try {
          if (kind === 'anthropic') {
            localStorage.setItem(LS_KEY_ANTHROPIC, entered);
            localStorage.removeItem(LS_KEY_ACCESS);
          } else if (kind === 'access') {
            localStorage.setItem(LS_KEY_ACCESS, entered);
            localStorage.removeItem(LS_KEY_ANTHROPIC);
          } else {
            localStorage.removeItem(LS_KEY_ANTHROPIC);
            localStorage.removeItem(LS_KEY_ACCESS);
          }
        } catch (e) {}

        var id = dom.aiCfgProviderType ? dom.aiCfgProviderType.value : 'anthropic';
        var pr = presetById(id);
        if (!pr.type) {
          // Anthropic valgt: fjern leverandøren helt, ellers ville en gammel
          // lagret config fortsatt vunnet presedensen i edgeAuthHeaders.
          try { localStorage.removeItem(LS_KEY_PROVIDER); localStorage.removeItem(LS_KEY_LLM); } catch (e) {}
        } else {
          var url = (dom.aiCfgProviderUrl ? dom.aiCfgProviderUrl.value : '').trim().replace(/\/+$/, '');
          var model = (dom.aiCfgProviderModel ? dom.aiCfgProviderModel.value : '').trim();
          var lkey = (dom.aiCfgLlmKey ? dom.aiCfgLlmKey.value : '').trim();
          try {
            if (url && model) {
              localStorage.setItem(LS_KEY_PROVIDER, JSON.stringify({ type: pr.type, base_url: url, model: model }));
            } else {
              // Ufullstendig config lagres ikke: providerConfig() ville
              // returnert null uansett, og en halvlagret leverandør er en
              // innstilling som ser satt ut men ikke virker.
              localStorage.removeItem(LS_KEY_PROVIDER);
            }
            if (lkey) localStorage.setItem(LS_KEY_LLM, lkey);
            else localStorage.removeItem(LS_KEY_LLM);
          } catch (e) {}
        }

        try {
          var q = dom.aiCfgQuality ? dom.aiCfgQuality.value : 'balanced';
          localStorage.setItem(LS_KEY_QUALITY, (q === 'fast' || q === 'best') ? q : 'balanced');
          // Egne instruksjoner (4000-cap — samme grense som serverens
          // coerceUserInstructions; tom verdi rydder nøkkelen helt bort).
          var instr = dom.aiCfgInstructions ? dom.aiCfgInstructions.value.trim().slice(0, 4000) : '';
          if (instr) localStorage.setItem('md_ai_instructions', instr);
          else localStorage.removeItem('md_ai_instructions');
        } catch (e) {}

        closeSettings();
      }

      function clearChat() {
        state.history = [];
        renderEmpty();
      }

      function init() {
        cacheDom();
        if (!dom.aiSidebar) return;

        dom.aiToggleBtn.addEventListener('click', toggleOpen);
        dom.aiCloseBtn.addEventListener('click', () => setOpen(false));
        dom.aiSettingsBtn.addEventListener('click', openSettings);
        dom.aiClearBtn.addEventListener('click', clearChat);
        dom.aiCfgSave.addEventListener('click', saveSettings);
        dom.aiCfgCancel.addEventListener('click', closeSettings);
        if (dom.aiCfgProviderType) {
          dom.aiCfgProviderType.addEventListener('change', function () {
            // Bytt preset → fyll URL/modell, men BARE når feltet er tomt eller
            // bar forrige presets verdi: en bruker som har skrevet sin egen
            // URL skal ikke få den overskrevet av et uhell med nedtrekkslista.
            var pr = presetById(dom.aiCfgProviderType.value);
            if (pr.type && dom.aiCfgProviderUrl && !dom.aiCfgProviderUrl.value.trim()) {
              dom.aiCfgProviderUrl.value = pr.url || '';
            }
            if (pr.type && dom.aiCfgProviderModel && !dom.aiCfgProviderModel.value.trim()) {
              dom.aiCfgProviderModel.value = pr.model || '';
            }
            syncProviderFields();
          });
        }
        dom.aiSettingsBackdrop.addEventListener('click', (e) => {
          if (e.target === dom.aiSettingsBackdrop) closeSettings();
        });

        if (dom.aiCfgByokRemove) {
          dom.aiCfgByokRemove.addEventListener('click', () => {
            // Begge slagene legitimasjon deler ETT felt, så «Fjern» må tømme
            // begge — ellers ville et lagret passord overlevd at brukeren
            // trodde han hadde fjernet nøkkelen.
            localStorage.removeItem(LS_KEY_ANTHROPIC);
            localStorage.removeItem(LS_KEY_ACCESS);
            if (dom.aiCfgAnthropicKey) dom.aiCfgAnthropicKey.value = '';
            if (dom.aiCfgByokStored) dom.aiCfgByokStored.style.display = 'none';
            if (window.mdSyncWebBtnVisibility) window.mdSyncWebBtnVisibility();
          });
        }

        // Samlet pipeline (spec 2026-08-28): Send går ALLTID til /api/svar —
        // ingen URL-ruting, ingen fast/web-splitt.
        function sendCurrent() { sendSvarMessage(); }
        if (dom.aiSendFastBtn) dom.aiSendFastBtn.addEventListener('click', sendCurrent);
        if (dom.aiAbortBtn) dom.aiAbortBtn.addEventListener('click', () => { if (state.abortCtrl) state.abortCtrl.abort(); });
        dom.aiInput.addEventListener('input', autoresize);
        dom.aiInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCurrent();   // Enter = send (modus fra menyen); Shift+Enter = ny linje
          }
        });

        // Historisk søm: index.html kaller denne ved modusbytte. Web-knappen
        // finnes ikke lenger (samlet pipeline) — bevisst no-op.
        window.mdSyncWebBtnVisibility = function () {};

        // Keyboard shortcut Ctrl+I
        document.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            toggleOpen();
          } else if (e.key === 'Escape') {
            if (dom.aiSettingsBackdrop.classList.contains('open')) closeSettings();
          }
        });

        // If Datasett sidebar opens later, close AI to keep mutual exclusion.
        if (dom.sidebarRight) {
          const observer = new MutationObserver(() => {
            const datasettOpen = !dom.sidebarRight.classList.contains('collapsed');
            const aiOpen = dom.aiSidebar.classList.contains('open');
            if (datasettOpen && aiOpen) setOpen(false);
          });
          observer.observe(dom.sidebarRight, { attributes: true, attributeFilter: ['class'] });
        }

        // Auth gate is in sendMessage; no auto-open of settings on first AI-panel
        // toggle. Users see the panel and the empty state; only Send triggers
        // the Settings dialog to collect a BYOK key.

        // Offentlig: åpne AI-panelet og send et spørsmål (brukes av hurtigspør-boksen i toppen).
        window.mdAskAi = function(question) {
          if (!question || !question.trim()) return;
          setOpen(true);
          dom.aiInput.value = question;
          autoresize();
          sendSvarMessage();
        };

        // Offentlig: åpne AI-panelet og tolk resultatene (output) fra forrige kjøring.
        window.mdInterpretResults = function(payload) {
          payload = payload || {};
          if (!payload.output || !payload.output.trim()) return;
          if (state.sending) return;
          if (!hasAiCredentials()) { openSettings(); return; }
          setOpen(true);
          if (state.history.length === 0) dom.aiThread.innerHTML = '';
          appendUserMessage(T('Tolk resultatene fra forrige kjøring.'));
          state.history.push({ role: 'user', text: 'Tolk resultatene' });
          const thinkingNode = appendThinking();
          state.sending = true;
          if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = true;
            const ctrl = new AbortController();
          state.abortCtrl = ctrl;
          if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = '';
          runInterpretQuery(payload, thinkingNode, ctrl.signal)
            .catch(e => { if (e.name !== 'AbortError') appendError(thinkingNode, '✗ ' + e.message); })
            .finally(() => {
              state.abortCtrl = null;
              if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = 'none';
              state.sending = false;
              if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = false;
                    if (dom.aiInput) dom.aiInput.focus();
            });
        };
      }

      // ── Sømmer for index.html ────────────────────────────────────────
      // dm-vurder-kallet bor i index.html og bygde sine egne headere med
      // X-Anthropic-Key hardkodet. Det ville vært den ENE AI-knappen som
      // ignorerte leverandørvalget. Eksponert her framfor å duplisere
      // presedens-logikken der.
      // Uten denne var AI-innstillingene KUN nåbare ved å prøve en spørring
      // uten nøkkel — man kunne ikke bytte en nøkkel man allerede hadde lagt
      // inn (Hans, 2026-08-27).
      window.mdOpenAiSettings = openSettings;
      window.mdAiAuthHeaders = edgeAuthHeaders;
      window.mdAiBodyExtras = edgeBodyExtras;
      window.mdAiHasCredentials = hasAiCredentials;

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
