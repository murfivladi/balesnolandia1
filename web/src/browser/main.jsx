import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import './browser.css';
import App from './App.jsx';
import { registerSW } from '../shared/pwa.js';

document.body.dataset.app = 'browser';
registerSW();
createRoot(document.getElementById('root')).render(<App />);
