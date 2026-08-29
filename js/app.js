import { initAuth, login, logout, authState } from './auth.js';
import { renderRoute } from './router.js';

async function bootstrap() {
  await initAuth();
  if (authState.session && authState.rol) {
    mostrarApp();
  } else if (authState.session && !authState.rol) {
    // Usuari vàlid a SAO però sense fila a gaco_usuaris_rol: sense accés a GACO.
    mostrarErrorSenseAccesGaco();
  } else {
    mostrarLogin();
  }
}

function mostrarLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
}

function mostrarErrorSenseAccesGaco() {
  const errorEl = document.getElementById('login-error');
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = "El teu usuari no té accés a GACO. Demana a l'administrador que et doni d'alta.";
}

function mostrarApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  document.getElementById('nav-user').textContent = `${authState.session.user.email} · ${authState.rol}`;
  document.getElementById('nav-configuracio').hidden = authState.rol !== 'admin';
  renderRoute();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  try {
    await login(email, password);
    if (!authState.rol) {
      mostrarErrorSenseAccesGaco();
      return;
    }
    mostrarApp();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = 'Correu o contrasenya incorrectes.';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await logout();
  mostrarLogin();
});

window.addEventListener('hashchange', renderRoute);

bootstrap();
