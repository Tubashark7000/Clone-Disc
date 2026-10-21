"use strict";
let selected = null;
const $ = (id) => document.getElementById(id);

function section(title, items, root) {
  if (!items.length) return;
  const h = document.createElement("h2");
  h.textContent = title;
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const s of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    b.setAttribute("aria-pressed", "false");
    b.title = s.name;
    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = s.thumb;
    thumb.alt = "";
    const label = document.createElement("div");
    label.className = "label";
    if (s.icon) {
      const ic = document.createElement("img");
      ic.src = s.icon;
      ic.alt = "";
      label.append(ic);
    }
    const name = document.createElement("span");
    name.textContent = s.name;
    label.append(name);
    b.append(thumb, label);
    b.addEventListener("click", () => {
      selected = s.id;
      document.querySelectorAll(".item").forEach((el) => el.setAttribute("aria-pressed", String(el === b)));
      $("share").disabled = false;
    });
    b.addEventListener("dblclick", () => window.picker.choose(s.id, $("audio").checked));
    grid.append(b);
  }
  root.append(h, grid);
}

window.picker.onSources(({ sources, audioRequested }) => {
  const root = $("list");
  section("Telas", sources.filter((s) => s.isScreen), root);
  section("Janelas", sources.filter((s) => !s.isScreen), root);
  if (audioRequested) $("audioBox").hidden = false;
  else $("spacer").hidden = false;
});

$("share").addEventListener("click", () => selected && window.picker.choose(selected, $("audio").checked));
$("cancel").addEventListener("click", () => window.picker.cancel());
document.addEventListener("keydown", (e) => e.key === "Escape" && window.picker.cancel());
