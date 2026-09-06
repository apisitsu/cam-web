import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntdApp, theme } from 'antd';
import '@ant-design/v5-patch-for-react-19';
import CamApp from './App.jsx';
import { CAD } from './theme.js';
import './index.css';

/**
 * Standalone shell. Everything below `App.jsx` is the engine-first CAD/CAM app;
 * this file only mounts it and states the theme.
 *
 * The theme is the light mechanical-CAD palette in `theme.js` (SolidWorks /
 * CATIA tone). antd is told the same thing in its own vocabulary so its buttons,
 * inputs and tables sit on the panels rather than on them — the `components`
 * block is that palette restated, plus the squarer CAD chrome (radius 4, 32px
 * rails), not a second set of colours.
 *
 * Vendored into EngineerSystem, `CamPage.jsx` provides this same provider scoped
 * to one route; here it is the whole document.
 */
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: CAD.accent,
          colorBgLayout: CAD.appBg,
          colorBgContainer: CAD.surface,
          colorBgElevated: CAD.surface,
          colorBorder: CAD.border,
          colorBorderSecondary: CAD.borderSoft,
          colorText: CAD.text,
          colorTextSecondary: CAD.label,
          colorTextTertiary: CAD.muted,
          colorTextQuaternary: CAD.dim,
          borderRadius: 4,
          fontSize: 13,
        },
        components: {
          Button: {
            colorPrimary: CAD.accent,
            defaultBg: '#f2f5f8',
            defaultBorderColor: CAD.border,
            controlHeight: 32,
            controlHeightSM: 26,
            borderRadius: 4,
          },
          Input: { controlHeight: 32, controlHeightSM: 24, borderRadius: 4 },
          InputNumber: { controlHeight: 32, controlHeightSM: 24, borderRadius: 4 },
          Select: { controlHeight: 32, controlHeightSM: 24, borderRadius: 4 },
          Segmented: {
            itemSelectedBg: CAD.selected,
            itemSelectedColor: CAD.text,
            trackBg: CAD.raised,
            borderRadius: 4,
          },
          Table: { headerBg: CAD.raised, borderColor: CAD.borderSoft },
          Statistic: { colorTextDescription: CAD.muted },
          Tooltip: { colorBgSpotlight: '#2b3440' },
        },
      }}
    >
      <AntdApp style={{ height: '100%' }}>
        <CamApp />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
);
