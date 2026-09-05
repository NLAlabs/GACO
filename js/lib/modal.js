/**
 * Modal genèric i reutilitzable — mateix patró de SAO (.modal / .modal-content
 * / .close / .active), recolorit amb les variables --gaco-*. Sense dependències.
 * Un sol modal obert a la vegada (obrir-ne un de nou tanca l'anterior).
 *
 * Ús:
 *   openModal({
 *     title: 'Nova factura',
 *     bodyHtml: '<p>...</p>',
 *     wide: false,              // opcional, modal més ample (classe modal-wide)
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
  overlayEl.className = 'modal active';
  overlayEl.innerHTML = `
    <div class="modal-content ${wide ? 'modal-wide' : ''}">
      <span class="close">&times;</span>
      <h2>${title}</h2>
      <div class="modal-body">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(overlayEl);
  onCloseActual = onClose ?? null;

  overlayEl.querySelector('.close').addEventListener('click', () => closeModal());
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
