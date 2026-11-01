import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { ToastProvider } from '../shared/ui.jsx';
import App from './App.jsx';
import { registerSW } from '../shared/pwa.js';

document.body.dataset.app = 'pos';
createRoot(document.getElementById('root')).render(<ToastProvider><App /></ToastProvider>);
registerSW();
