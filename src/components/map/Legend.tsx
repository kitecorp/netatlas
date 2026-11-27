/** What the lines and boxes on the map mean. */
export function Legend() {
  return (
    <div className="map-legend">
      <span className="dot-line">
        <svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8" className="line-networkpolicy">
          <path d="M1 4 L27 4" />
        </svg>
        a NetworkPolicy allows it
      </span>
      <span className="dot-line">
        <svg aria-hidden="true" width="28" height="8" viewBox="0 0 28 8" className="line-istio">
          <path d="M1 4 L27 4" />
        </svg>
        an Istio AuthorizationPolicy allows it
      </span>
      <span className="dot-line">
        <svg aria-hidden="true" width="20" height="14" viewBox="0 0 20 14" className="legend-open">
          <rect x="1" y="1" width="18" height="12" rx="3" />
        </svg>
        no policy selects it, so everything may reach it
      </span>
    </div>
  );
}
