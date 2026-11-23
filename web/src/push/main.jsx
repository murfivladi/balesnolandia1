import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { ToastProvider } from '../shared/ui.jsx';
import { registerSW } from '../shared/pwa.js';
import App from './App.jsx';

document.body.dataset.app = 'push';
registerSW();
createRoot(document.getElementById('root')).render(<ToastProvider><App /></ToastProvider>);
