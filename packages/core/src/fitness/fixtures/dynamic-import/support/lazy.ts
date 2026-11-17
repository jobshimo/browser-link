// RED: a dynamic import() in core (a module service worker refuses it).
export const load = () => import('./other.js');
