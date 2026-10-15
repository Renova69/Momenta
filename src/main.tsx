import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// N-135 — the typefaces ship with the app. They came from Google Fonts, which
// the production CSP refuses, so production never showed them; and in
// development every guest's phone told Google which album it had opened.
// Each file declares its subsets by unicode-range: a phone downloads only the
// ones its text uses.
import '@fontsource/cormorant-garamond/300.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/400-italic.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/700.css';
// N-149 — the body typeface. Plus Jakarta Sans had no basic Cyrillic, so in
// Bulgarian every line of body text fell back to the phone's system font.
// Sofia Sans was drawn by a Bulgarian foundry (Lettersoup) with the Bulgarian
// letterforms; one variable file per script covers every weight.
import '@fontsource-variable/sofia-sans';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
