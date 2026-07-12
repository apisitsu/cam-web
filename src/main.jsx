import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import '@ant-design/v5-patch-for-react-19';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#38bdf8' } }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
