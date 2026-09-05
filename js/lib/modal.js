/**
 * Modal genèric i reutilitzable. Sense dependències.
 * Un sol modal obert a la vegada (obrir-ne un de nou tanca l'anterior).
 *
 * Ús:
 *   openModal({
 *     title: 'Nova factura',
 *     bodyHtml: '<p>...</p>',
 *     wide: false,              // opcional, modal més ample
 *     onMount: (bodyEl) => {},  // opcional, per enganxar listeners un cop al DOM
 *     onClose: () => {},        // opcional, en tancar (X, fora, Escape)
 *   });
 *   closeModal();
 */

let overlayEl = null;
let onCloseActual = null;

export function openModal({ title, bodyHtml, wide = false, onMount, onClose }) {
  closeModal();

  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay';
  overlayEl.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''}">
      <button type="button" class="modal-close" aria-label="Tancar">✕</button>
      <p class="modal-title">${title}</p>
      <div class="modal-body">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(overlayEl);
  onCloseActual = onClose ?? null;

  overlayEl.querySelector('.modal-close').addEventListener('click', () => closeModal());
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeModal();
  });
  document.addEventListener('keydown', escHandler);

  const bodyElement = overlayEl.querySelector('.modal-body');
  if (onMount) onMount(bodyElement);
  return overlayEl;
}

function escHandler(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  if (!overlayEl) return;
  document.removeEventListener('keydown', escHandler);
  overlayEl.remove();
  overlayEl = null;
  const cb = onCloseActual;
  onCloseActual = null;
  if (cb) cb();
}
