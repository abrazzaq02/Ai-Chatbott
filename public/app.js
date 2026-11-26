// StudyBuddy frontend: chat UI, local chat history, streaming from /api/chat.
(() => {
  const API_URL = "/api/chat";
  const STORE_KEY = "studybuddy.chats.v1";

  const $ = (id) => document.getElementById(id);
  const el = {
    messages: $("messages"), empty: $("empty"), input: $("input"), composer: $("composer"),
    send: $("sendBtn"), stop: $("stopBtn"), mode: $("mode"), subject: $("subject"), level: $("level"),
    history: $("history"), newChat: $("newChat"), clearAll: $("clearAll"), title: $("chatTitle"),
    sidebar: $("sidebar"), backdrop: $("backdrop"), menu: $("menuBtn"),
  };

  // ---------- storage ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(chats)); } catch {}
  }

  let chats = load();
  let current = null; // active chat object
  let controller = null; // AbortController for the in-flight request

  function newChat() {
    current = { id: Date.now().toString(36), title: "New chat", mode: el.mode.value, subject: "", level: "", messages: [] };
    render();
  }

  function persistCurrent() {
    if (!current.messages.length) return;
    if (!chats.includes(current)) chats.unshift(current);
    save();
    renderHistory();
  }

  // ---------- rendering ----------
  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
    }
    const div = document.createElement("div");
    div.textContent = text;
    return `<p style="white-space:pre-wrap">${div.innerHTML}</p>`;
  }

  function addBubble(role, text) {
    el.empty.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    wrap.appendChild(bubble);
    el.messages.appendChild(wrap);
    setBubble(bubble, role, text);
    return bubble;
  }

  function setBubble(bubble, role, text) {
    if (role === "user" || role === "error") bubble.textContent = text;
    else bubble.innerHTML = renderMarkdown(text);
  }

  function addActions(bubble, text) {
    const bar = document.createElement("div");
    bar.className = "actions";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); copy.textContent = "Copied!"; }
      catch { copy.textContent = "Copy failed"; }
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    bar.appendChild(copy);
    bubble.appendChild(bar);
  }

  function scrollDown() { el.messages.scrollTop = el.messages.scrollHeight; }

  function render() {
    el.messages.querySelectorAll(".msg").forEach((n) => n.remove());
    el.empty.hidden = current.messages.length > 0;
    el.mode.value = current.mode || "explain";
    el.subject.value = current.subject || "";
    el.level.value = current.level || "";
    el.title.textContent = current.title;
    for (const m of current.messages) {
      const b = addBubble(m.role, m.content);
      if (m.role === "assistant") addActions(b, m.content);
    }
    renderHistory();
    scrollDown();
  }

  function renderHistory() {
    el.history.innerHTML = "";
    for (const chat of chats) {
      const li = document.createElement("li");
      if (current && chat.id === current.id) li.className = "active";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = chat.title;
      const del = document.createElement("button");
      del.className = "del";
      del.title = "Delete chat";
      del.textContent = "×";
      del.onclick = (e) => {
        e.stopPropagation();
        chats = chats.filter((c) => c.id !== chat.id);
        save();
        if (current.id === chat.id) newChat(); else renderHistory();
      };
      li.onclick = () => { if (!controller) { current = chat; render(); closeMenu(); } };
      li.append(name, del);
      el.history.appendChild(li);
    }
  }

  function setBusy(busy) {
    el.send.hidden = busy;
    el.stop.hidden = !busy;
    el.input.disabled = busy;
  }

  // ---------- sending ----------
  async function send(text) {
    text = text.trim();
    if (!text || controller) return;

    current.mode = el.mode.value;
    current.subject = el.subject.value.trim();
    current.level = el.level.value;
    if (!current.messages.length) {
      current.title = text.length > 40 ? text.slice(0, 40) + "…" : text;
      el.title.textContent = current.title;
    }
    current.messages.push({ role: "user", content: text });
    addBubble("user", text);
    persistCurrent();

    el.input.value = "";
    autoGrow();

    const bubble = addBubble("assistant", "");
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    scrollDown();

    controller = new AbortController();
    setBusy(true);
    let answer = "";
    let errorMsg = null;
    let finished = false; // stops late animation-frame repaints after the final render

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: current.messages,
          mode: current.mode,
          subject: current.subject,
          level: current.level,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let msg = `Server error (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pending = false;
      const paint = () => {
        pending = false;
        if (finished) return;
        const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
        setBubble(bubble, "assistant", answer);
        if (nearBottom) scrollDown();
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const lineText = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!lineText) continue;
          let evt;
          try { evt = JSON.parse(lineText); } catch { continue; }
          if (evt.type === "text") {
            answer += evt.text;
            if (!pending) { pending = true; requestAnimationFrame(paint); }
          } else if (evt.type === "error") {
            errorMsg = evt.error;
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") errorMsg = err.message || "Network error";
    } finally {
      finished = true;
      controller = null;
      setBusy(false);
    }

    if (answer) {
      setBubble(bubble, "assistant", answer);
      addActions(bubble, answer);
      current.messages.push({ role: "assistant", content: answer });
    } else {
      bubble.parentElement.remove();
    }
    if (errorMsg) {
      addBubble("error", "⚠️ " + errorMsg);
      // Drop the unanswered question so the conversation stays valid; restore it to the box.
      if (!answer) {
        current.messages.pop();
        el.input.value = text;
        autoGrow();
      }
    }
    if (!current.messages.length) chats = chats.filter((c) => c !== current);
    save();
    renderHistory();
    scrollDown();
    el.input.focus();
  }

  // ---------- UI wiring ----------
  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
  }
  function closeMenu() { el.sidebar.classList.remove("open"); el.backdrop.classList.remove("show"); }

  el.composer.addEventListener("submit", (e) => { e.preventDefault(); send(el.input.value); });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(el.input.value); }
  });
  el.input.addEventListener("input", autoGrow);
  el.stop.addEventListener("click", () => controller && controller.abort());
  el.newChat.addEventListener("click", () => { if (!controller) { newChat(); closeMenu(); el.input.focus(); } });
  el.clearAll.addEventListener("click", () => {
    if (controller || !chats.length) return;
    if (confirm("Delete all saved chats?")) { chats = []; save(); newChat(); }
  });
  el.menu.addEventListener("click", () => { el.sidebar.classList.add("open"); el.backdrop.classList.add("show"); });
  el.backdrop.addEventListener("click", closeMenu);
  el.mode.addEventListener("change", () => { current.mode = el.mode.value; if (current.messages.length) save(); });
  document.querySelectorAll(".suggestions button").forEach((b) =>
    b.addEventListener("click", () => { el.mode.value = b.dataset.mode; send(b.dataset.text); })
  );

  newChat();
  el.input.focus();
})();
