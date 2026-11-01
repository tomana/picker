

const app = document.getElementById("app");

async function show() {
  /* Catch render failures as well as import failures so a late exception cannot blank the shell. */

  try {
    const [page, loader] = await Promise.all([
      import("./page.js"),
      import("./data.js"),
    ]);
    /* Do not replace failed API reads with fabricated data. */
    const data = await loader.load();
    const ui = page.build();
    let style = document.getElementById("design-css");
    if (!style) {
      style = document.createElement("style");
      style.id = "design-css";
      document.head.append(style);
    }
    style.textContent = ui.css || "";
    app.replaceChildren(ui.render(data));

    /* Coalesce late-data repaints per frame and contain render errors without discarding the current page. */

    let queued = 0;
    data.onUpdate = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        try { app.replaceChildren(ui.render(data)); }
        catch (e) { console.error("repaint:", e); }
      });
    };
  } catch (e) {
    console.error("page:", e);
    app.replaceChildren(Object.assign(document.createElement("p"), {
      textContent: `page failed: ${e.message}`,
      style: "color:var(--down);padding:24px 16px;font:13px monospace",
    }));
  }
}

/* URL-bar collapse requires a touch gesture; programmatic scrolling cannot force it. */

show();
/* Start each plugin page module only once. */
fetch("/api/plugins").then((r) => r.json())
  .then(({ pages = [] }) => pages.forEach((u) => import(u).then((m) => m.start && m.start())))
  .catch(() => {});
