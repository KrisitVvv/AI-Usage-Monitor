const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 600,
    minHeight: 420,
    frame: false,
    icon: path.join(__dirname, '..', 'public', 'square_logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true, 
      preload: path.join(__dirname, 'preload.js') 
    }
  })

  // 开发模式下加载 Vite 服务器
  win.loadURL('http://localhost:5173')

  // 可选：打开 DevTools
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  createWindow()

  ipcMain.on('window-minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })
  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})