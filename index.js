// ChatSlim — keep giant SillyTavern chats from killing the browser.
//
// Born from a 2,457-message / 18.7MB chat that produced "Out of Memory" and
// STATUS_BREAKPOINT renderer crashes. Measured on that chat: only 21% of the
// file was visible message text — the rest was unchosen swipes and per-message
// extension metadata (summariser scratch duplicated into every swipe).
//
// What it does:
//   1. Warns when the loaded chat's in-memory JSON passes a size threshold.
//   2. "Slim" — for messages older than the last N:
//        - drops unchosen swipes (visible message + its swipe are untouched)
//        - drops nested swipe_info[].extra blobs
//      and everywhere blanks known scratch fields (qvink_memory.reasoning).
//      Verifies the visible transcript is byte-identical before saving.
//   3. "Slim & Branch" — slims, then runs ST's native /branch so you continue
//      in a fresh light file while the original stays intact.
//
// Nothing is deleted that the model or the reader can see. Ever.

(function () {
    'use strict';

    const MODULE = 'chatslim';
    const DEFAULTS = { warnMB: 6, keepLast: 60, stripScratch: true, tailLength: 300 };

    function ctx() { return (window.SillyTavern && SillyTavern.getContext) ? SillyTavern.getContext() : null; }

    function getSettings() {
        const c = ctx();
        if (!c) return { ...DEFAULTS };
        c.extensionSettings[MODULE] = Object.assign({}, DEFAULTS, c.extensionSettings[MODULE] || {});
        return c.extensionSettings[MODULE];
    }

    function saveSettings() {
        const c = ctx();
        if (c && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
    }

    function chatBytes(chat) {
        try { return JSON.stringify(chat).length; } catch (e) { return 0; }
    }

    function fmtMB(n) { return (n / 1048576).toFixed(1) + 'MB'; }

    function visibleTranscript(chat) {
        // Everything a reader/model can see: name, role, chosen text.
        return chat.map(m => [m.name, m.is_user ? 1 : 0, m.mes || ''].join('')).join('');
    }

    function slimChat(chat, keepLast, stripScratch) {
        const cut = Math.max(0, chat.length - keepLast);
        let touched = 0;
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (stripScratch && m.extra && m.extra.qvink_memory && m.extra.qvink_memory.reasoning) {
                m.extra.qvink_memory.reasoning = '';
                touched++;
            }
            if (Array.isArray(m.swipe_info)) {
                for (const s of m.swipe_info) {
                    if (s && s.extra) {
                        if (s.extra.qvink_memory) { delete s.extra.qvink_memory; touched++; }
                        if (s.extra.reasoning) { s.extra.reasoning = ''; touched++; }
                    }
                }
            }
            if (i < cut && Array.isArray(m.swipes) && m.swipes.length > 1) {
                const idx = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
                // The visible message always wins; never trust an out-of-range index.
                const chosen = (idx >= 0 && idx < m.swipes.length && m.swipes[idx] === m.mes) ? m.swipes[idx] : m.mes;
                m.swipes = [chosen];
                m.swipe_id = 0;
                if (Array.isArray(m.swipe_info) && m.swipe_info.length > 1) {
                    m.swipe_info = [m.swipe_info[Math.min(idx, m.swipe_info.length - 1)]];
                }
                touched++;
            }
        }
        return touched;
    }

    async function doSlim(andBranch) {
        const c = ctx();
        if (!c || !Array.isArray(c.chat) || c.chat.length === 0) {
            toastr.warning('No chat loaded.', 'ChatSlim');
            return;
        }
        const s = getSettings();
        const before = chatBytes(c.chat);
        const transcriptBefore = visibleTranscript(c.chat);

        const touched = slimChat(c.chat, Number(s.keepLast) || DEFAULTS.keepLast, !!s.stripScratch);

        // Safety gate: the visible transcript must be byte-identical.
        if (visibleTranscript(c.chat) !== transcriptBefore) {
            toastr.error('Verification failed — nothing saved. Reload the chat.', 'ChatSlim');
            return;
        }
        const after = chatBytes(c.chat);

        if (touched === 0 || before - after < before * 0.02) {
            toastr.info('Already slim (' + fmtMB(after) + ') — nothing worth saving.', 'ChatSlim');
        } else {
            try {
                await c.saveChat();
                toastr.success(fmtMB(before) + ' → ' + fmtMB(after) + ' (' + touched + ' messages cleaned)', 'ChatSlim');
            } catch (e) {
                console.error('[ChatSlim] save failed', e);
                toastr.error('Save failed — see console. Chat on disk untouched.', 'ChatSlim');
                return;
            }
        }

        if (andBranch) {
            try {
                const run = c.executeSlashCommandsWithOptions || c.executeSlashCommands || window.executeSlashCommands;
                await run.call(c, '/branch');
                // ST's native branch copies the ENTIRE history into the new file.
                // Trim the fresh branch to the last tailLength messages so the
                // new file is actually light. The original file keeps everything.
                await new Promise(r => setTimeout(r, 1500));
                const c2 = ctx();
                const tail = Number(getSettings().tailLength) || DEFAULTS.tailLength;
                if (c2 && Array.isArray(c2.chat) && c2.chat.length > tail) {
                    const removed = c2.chat.length - tail;
                    c2.chat.splice(0, removed);
                    await c2.saveChat();
                    if (typeof c2.reloadCurrentChat === 'function') await c2.reloadCurrentChat();
                    toastr.success('Branched and trimmed to the last ' + tail + ' messages (' + removed + ' left behind in the original).', 'ChatSlim');
                } else {
                    toastr.success('Branched — you are now in a fresh file.', 'ChatSlim');
                }
            } catch (e) {
                console.error('[ChatSlim] branch failed', e);
                toastr.error('Branch failed — use Chat Management > Create Branch.', 'ChatSlim');
            }
        }
    }

    function checkSize() {
        const c = ctx();
        if (!c || !Array.isArray(c.chat) || c.chat.length === 0) return;
        const s = getSettings();
        const bytes = chatBytes(c.chat);
        const el = document.getElementById('chatslim_status');
        if (el) {
            el.textContent = 'Current chat: ' + fmtMB(bytes) + ' in memory, ' + c.chat.length + ' messages';
        }
        if (bytes > (Number(s.warnMB) || DEFAULTS.warnMB) * 1048576) {
            toastr.warning(
                'This chat is ' + fmtMB(bytes) + ' in browser memory. Big chats cause slow loads and renderer crashes — consider Slim & Branch (Extensions ▸ ChatSlim).',
                'ChatSlim', { timeOut: 12000 }
            );
        }
    }

    function addUI() {
        const s = getSettings();
        const html = `
        <div class="chatslim_block">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>ChatSlim</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div id="chatslim_status" class="chatslim_status"></div>
                    <label>Warn when chat exceeds
                        <input id="chatslim_warn" type="number" min="1" max="64" step="1" value="${s.warnMB}" class="chatslim_num"> MB
                    </label>
                    <label>Keep full swipes on the last
                        <input id="chatslim_keep" type="number" min="10" max="500" step="10" value="${s.keepLast}" class="chatslim_num"> messages
                    </label>
                    <label>Branch carries the last
                        <input id="chatslim_tail" type="number" min="50" max="2000" step="50" value="${s.tailLength}" class="chatslim_num"> messages
                    </label>
                    <label class="checkbox_label">
                        <input id="chatslim_scratch" type="checkbox" ${s.stripScratch ? 'checked' : ''}>
                        Strip extension scratch data (summariser reasoning)
                    </label>
                    <div class="chatslim_buttons">
                        <div id="chatslim_slim" class="menu_button">Slim this chat</div>
                        <div id="chatslim_branch" class="menu_button">Slim &amp; Branch</div>
                    </div>
                    <small>Never touches visible text, chosen swipes, or summariser memories. Verified before every save.</small>
                </div>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);
        $('#chatslim_warn').on('input', function () { getSettings().warnMB = Number(this.value) || DEFAULTS.warnMB; saveSettings(); });
        $('#chatslim_keep').on('input', function () { getSettings().keepLast = Number(this.value) || DEFAULTS.keepLast; saveSettings(); });
        $('#chatslim_tail').on('input', function () { getSettings().tailLength = Number(this.value) || DEFAULTS.tailLength; saveSettings(); });
        $('#chatslim_scratch').on('input', function () { getSettings().stripScratch = this.checked; saveSettings(); });
        $('#chatslim_slim').on('click', () => doSlim(false));
        $('#chatslim_branch').on('click', () => doSlim(true));
    }

    jQuery(function () {
        try {
            addUI();
            const c = ctx();
            const et = c && (c.eventTypes || c.event_types);
            if (c && c.eventSource && et && et.CHAT_CHANGED) {
                c.eventSource.on(et.CHAT_CHANGED, () => setTimeout(checkSize, 500));
            }
            setTimeout(checkSize, 3000);
            console.log('[ChatSlim] ready');
        } catch (e) {
            console.error('[ChatSlim] init failed', e);
        }
    });
})();
