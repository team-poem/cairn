const app = document.querySelector("#app");
const config = await fetch("/api/config").then((response) => response.json());
// A deployed visitor can inspect the same variants without changing another session.
const variant =
  new URLSearchParams(location.search).get("variant") ?? config.variant;
let customer = { name: "", email: "" };
let inBag = false;
const summary =
  '<aside class="summary"><p class="eyebrow">YOUR BAG · 1 ITEM</p><div class="line"><span>Field notebook · Rust</span><span>$18</span></div><p>1 × A5 / dotted / 160 pages</p><div class="line"><span>Delivery</span><span>On us</span></div><div class="line"><strong>Total</strong><strong>$18</strong></div><p class="muted">This is a sample order. Nothing is charged or shipped.</p></aside>';
function go(path) {
  history.pushState(
    {},
    "",
    path +
      (variant !== "original" ? `?variant=${encodeURIComponent(variant)}` : ""),
  );
  render();
}
function render() {
  const route = location.pathname;
  if (route === "/shop/checkout" && inBag) {
    app.innerHTML = `<section class="checkout"><p class="steps">01 BAG &nbsp; / &nbsp; 02 DETAILS &nbsp; / &nbsp; 03 ORDER</p><h1>Where should it go?</h1><p class="muted">Use Alex Demo and alex@example.test to try the sample checkout.</p><div class="checkout-grid"><form id="details"><label for="customer-name">Full name</label><input id="customer-name" name="name" autocomplete="off" required maxlength="80"><label for="customer-email">Email</label><input id="customer-email" name="email" type="email" aria-label="Email address for this order" autocomplete="off" required maxlength="120"><button class="primary">Review order →</button></form>${summary}</div></section>`;
    app.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      customer = Object.fromEntries(new FormData(event.currentTarget));
      go("/shop/review");
    });
  } else if (route === "/shop/review" && inBag && customer.name) {
    const control =
      variant === "original"
        ? '<button class="primary" id="order">Place order</button>'
        : '<a class="primary" id="order" href="/shop/complete">Place order</a>';
    app.innerHTML = `<section class="checkout"><p class="steps">01 BAG &nbsp; / &nbsp; 02 DETAILS &nbsp; / &nbsp; 03 ORDER</p><h1>A little space for<br>your next idea.</h1><div class="checkout-grid"><div><p class="eyebrow">READY WHEN YOU ARE</p><p>Your notebook is ready to go.</p><p class="muted">Demo checkout only. No payment details needed.</p><div class="details">A5 format · 160 dotted pages<br>Rust linen cover · Opens flat</div>${control}<p id="error" role="status"></p></div>${summary}</div></section>`;
    let submitting = false;
    app.querySelector("#order").addEventListener("click", async (event) => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      try {
        await fetch("/api/order", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Demo-Variant": variant,
          },
          body: JSON.stringify({
            ...customer,
            product: "field-notebook",
            quantity: 1,
          }),
        });
        // The deliberate defect: even a rejected order reaches this success screen.
        // The frozen POST assertion must still catch it; visual arrival is insufficient.
        go("/shop/complete");
      } catch {
        app.querySelector("#error").textContent =
          "Cannot reach the demo server. Please try again.";
        submitting = false;
      }
    });
  } else if (route === "/shop/complete" && inBag) {
    app.innerHTML = `<section class="success"><div class="seal">✓</div><p class="eyebrow">DEMO ORDER · 1042</p><h1>Good things<br>are on their way.</h1><p>Thanks for making room for your next idea.<br>Your sample order is complete.</p>${summary}<a href="/shop/">Back to the shop ↗</a></section>`;
  } else {
    app.innerHTML = `<section class="product"><div class="art" role="img" aria-label="Rust linen notebook"><div class="notebook"><b>field<br>notes.</b><i>room for a thought</i></div></div><div><p class="eyebrow">THE EVERYDAY COLLECTION / 001</p><h1>A little space<br>for big ideas.</h1><p class="description">Meet the Field notebook. Thoughtfully simple, pleasantly tactile, and ready for whatever is on your mind.</p><p class="price">$18 <span class="muted">/ Rust linen</span></p><button id="add" class="primary">Add to bag →</button><div class="details">A5 format · 160 dotted pages<br>Responsibly sourced paper · Opens flat</div></div></section>`;
    app.querySelector("#add").addEventListener("click", () => {
      inBag = true;
      go("/shop/checkout");
    });
  }
}
window.addEventListener("popstate", render);
render();
