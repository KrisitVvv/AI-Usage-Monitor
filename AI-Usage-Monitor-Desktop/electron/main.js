const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,      // 安全
      contextIsolation: true,      // 安全
      preload: path.join(__dirname, 'preload.js') // 预加载脚本
    }
  })

  // 开发模式下加载 Vite 服务器
  win.loadURL('http://localhost:5173')

  // 可选：打开 DevTools
  // win.webContents.openDevTools()
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})