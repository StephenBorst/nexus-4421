import { useEffect, useState } from "react";

// Temporary viewport diagnostics. Renders ONLY when the URL has ?vhdebug (so normal
// users never see it). Lets us read the real height values from in-app wallet browsers
// (Zerion etc.) that mis-handle vh/dvh, to pin down the app-wide mobile dead space.
export default function VhDebug() {
  const [, force] = useState(0);
  const on = typeof window !== "undefined" && /[?&]vhdebug/.test(window.location.search);

  useEffect(() => {
    if (!on) return;
    const rerender = () => force((n) => n + 1);
    window.addEventListener("resize", rerender);
    window.visualViewport?.addEventListener("resize", rerender);
    const t = setInterval(rerender, 500);
    return () => {
      window.removeEventListener("resize", rerender);
      window.visualViewport?.removeEventListener("resize", rerender);
      clearInterval(t);
    };
  }, [on]);

  if (!on) return null;

  const de = document.documentElement;
  const root = document.querySelector(".oui-scaffold-root") as HTMLElement | null;
  const rootRect = root?.getBoundingClientRect();
  // Measure what each CSS viewport unit actually resolves to in this webview.
  const probe = (unit: string) => {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;top:0;left:0;width:1px;height:100${unit};visibility:hidden;pointer-events:none`;
    document.body.appendChild(d);
    const h = Math.round(d.getBoundingClientRect().height);
    d.remove();
    return h;
  };
  const rows: [string, string | number][] = [
    ["innerHeight", window.innerHeight],
    ["outerHeight", window.outerHeight],
    ["visualVp.h", window.visualViewport ? Math.round(window.visualViewport.height) : "n/a"],
    ["docEl.clientH", de.clientHeight],
    ["screen.avail", window.screen?.availHeight ?? "n/a"],
    ["svh / dvh / lvh", `${probe("svh")} / ${probe("dvh")} / ${probe("lvh")}`],
    ["--app-vh", getComputedStyle(de).getPropertyValue("--app-vh").trim() || "unset"],
    ["scaffold.h", rootRect ? Math.round(rootRect.height) : "no-root"],
    ["scaffold.bottom", rootRect ? Math.round(rootRect.bottom) : "no-root"],
    ["gap(inner-bottom)", rootRect ? Math.round(window.innerHeight - rootRect.bottom) : "n/a"],
    ["dpr", window.devicePixelRatio],
  ];

  return (
    <div
      style={{
        position: "fixed", top: 6, left: 6, zIndex: 99999,
        background: "rgba(0,0,0,0.88)", color: "#00ff88", border: "1px solid #00ff88",
        borderRadius: 6, padding: "8px 10px", fontFamily: "monospace", fontSize: 11,
        lineHeight: 1.5, pointerEvents: "none", maxWidth: "70vw",
      }}
    >
      <div style={{ color: "#fff", fontWeight: "bold", marginBottom: 4 }}>VH DEBUG</div>
      {rows.map(([k, v]) => (
        <div key={k}>{k}: <b style={{ color: "#fff" }}>{String(v)}</b></div>
      ))}
    </div>
  );
}
