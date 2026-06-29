// Коннектор к бессрочным фьючерсам Gate.io (линейные USDT-перпы).
// Тонкая обёртка над обобщённой ccxt-фабрикой с type='swap'.
import { createCexConnector } from './cexFactory.js';
import config from '../config/env.js';

const gateFutures = createCexConnector('gate', {
  apiKey: config.gateApiKey,
  secret: config.gateApiSecret,
  quote: 'USDT',
  chain: 'BSC',
  type: 'swap',
});

export default gateFutures;
