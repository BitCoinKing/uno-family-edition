export class AnimationEngine {
  flyCardToDiscard(cardElement, discardElement) {
    if (!cardElement || !discardElement) return;

    const start = cardElement.getBoundingClientRect();
    const end = discardElement.getBoundingClientRect();
    const clone = cardElement.cloneNode(true);

    clone.classList.add("anim-clone");
    clone.style.left = `${start.left}px`;
    clone.style.top = `${start.top}px`;
    clone.style.width = `${start.width}px`;
    clone.style.height = `${start.height}px`;
    document.body.appendChild(clone);

    requestAnimationFrame(() => {
      clone.style.transform = `translate(${end.left - start.left}px, ${end.top - start.top}px) scale(0.92) rotate(${Math.random() * 10 - 5}deg)`;
      clone.style.opacity = "0.85";
    });

    setTimeout(() => clone.remove(), 360);
  }

  zoomTurnBanner(element) {
    if (!element) return;
    element.classList.remove("turn-zoom");
    void element.offsetWidth;
    element.classList.add("turn-zoom");
  }

  shakeScreen(root) {
    if (!root) return;
    root.classList.remove("screen-shake");
    void root.offsetWidth;
    root.classList.add("screen-shake");
  }
}
