// Общее для страниц ВлодУслуг: данные гражданина и названия документов.
import { get } from '../shared/api.js';
import { useAsync } from '../shared/ui.jsx';

export const DOC_TITLES = {
  inn: 'ИНН',
  ip: 'Свидетельство ИП',
  driver: 'Водительские права',
  marriage: 'Свидетельство о браке',
  birth: 'Свидетельство о рождении',
  foreign_passport: 'Загранпаспорт',
  visa: 'Виза',
};

export function useGovMe() {
  return useAsync(() => get('/gov/me'), []);
}

export const DRIVER_CATEGORIES = ['A', 'B', 'C', 'AB', 'BC'];
