function formatPrice(priceCents, currency) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(priceCents / 100);
}

export default function ProductCard({ product }) {
  return (
    <section className="card product" aria-labelledby="product-name">
      <svg className="phone" viewBox="0 0 120 220" role="img" aria-label="Illustration of a smartphone">
        <rect x="8" y="4" width="104" height="212" rx="18" fill="#2a2f3a" stroke="#4a5163" strokeWidth="3" />
        <rect x="16" y="20" width="88" height="170" rx="8" fill="#ff6a3d" />
        <circle cx="60" cy="205" r="5" fill="#4a5163" />
        <rect x="46" y="9" width="28" height="5" rx="2.5" fill="#4a5163" />
      </svg>
      <div>
        <h1 id="product-name">{product.name}</h1>
        <p className="price">{formatPrice(product.priceCents, product.currency)}</p>
        <ul className="specs">
          <li>Limited drop: 500 units</li>
          <li>One per customer</li>
          <li>6.5&quot; display, 256 GB</li>
        </ul>
      </div>
    </section>
  );
}