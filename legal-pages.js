// Hebrew legal pages module — re-exports runtime handler from skills.js
// (skills.js is already in the Docker image; edit markdown in docs/legal/).
//
// When Dockerfile is updated, you may import directly from this file instead:
//   COPY legal-pages.js ./
//   COPY docs/legal ./docs/legal

export { handleLegalRoutes, LEGAL_PATHS } from './skills.js';
