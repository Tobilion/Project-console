// G-5 (2026-09-09): the shared liquid-glass SVG filter (ported from the Phase G
// Appendix-A reference component's GlassFilter — filter definition ONLY, not the
// LiquidButton/MetalButton variants, so no new runtime dependencies). Mounted once in
// App next to GlowOrbs; every `.glass-lens` surface references it by url(#container-glass)
// when <html data-liquid-glass="on">. feTurbulence + feDisplacementMap distort the
// backdrop (real refraction, not just blur); the trailing Gaussian keeps it soft.
// INVARIANT: this must stay mounted unconditionally — the CSS rule degrades to plain
// backdrop-blur only while the filter resolves, and a removed SVG would drop the blur
// with it (invalid computed value), so never gate this behind the toggle.
export function GlassFilter() {
  return (
    <svg className="hidden" aria-hidden="true">
      <defs>
        <filter
          id="container-glass"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.05 0.05"
            numOctaves="1"
            seed="1"
            result="turbulence"
          />
          <feGaussianBlur in="turbulence" stdDeviation="2" result="blurredNoise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="blurredNoise"
            scale="70"
            xChannelSelector="R"
            yChannelSelector="B"
            result="displaced"
          />
          <feGaussianBlur in="displaced" stdDeviation="4" result="finalBlur" />
          <feComposite in="finalBlur" in2="finalBlur" operator="over" />
        </filter>
      </defs>
    </svg>
  );
}
