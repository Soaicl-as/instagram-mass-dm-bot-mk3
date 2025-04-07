import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '..')));

// Handle any requests that don't match the above
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

interface InstagramAutomation {
  username: string;
  extractType: 'followers' | 'following';
  message: string;
  delayBetweenMsgs: number;
  maxAccounts: number;
}

const INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME;
const INSTAGRAM_PASSWORD = process.env.INSTAGRAM_PASSWORD;

if (!INSTAGRAM_USERNAME || !INSTAGRAM_PASSWORD) {
  console.warn('Warning: Instagram credentials not set in environment variables. Login will fail.');
}

let stopProcess = false;

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getUserList(
  page: puppeteer.Page,
  targetUsername: string,
  extractType: 'followers' | 'following',
  maxAccounts: number
): Promise<string[]> {
  await page.goto(`https://www.instagram.com/${targetUsername}/${extractType}/`);
  await delay(3000);

  const users: string[] = [];
  const scrollAttempts = Math.min(3, maxAccounts / 10);

  for (let i = 0; i < scrollAttempts && !stopProcess; i++) {
    const newUsers = await page.evaluate(() => {
      const elements = document.querySelectorAll('div[role="dialog"] a[role="link"][title]');
      return Array.from(elements).map(el => el.getAttribute('title')).filter(Boolean) as string[];
    });

    users.push(...newUsers);
    if (users.length >= maxAccounts) break;

    await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        (dialog as Element).scrollTo(0, (dialog as Element).scrollHeight);
      }
    });
    await delay(1500);
  }

  return [...new Set(users)].slice(0, maxAccounts);
}

async function sendMassDM(socket: any, data: InstagramAutomation) {
  const { username, extractType, message, delayBetweenMsgs, maxAccounts } = data;
  let browser;
  let processedCount = 0;

  try {
    socket.emit('update', 'Launching browser...');
    
    // Modified to work better on Render
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=IsolateOrigins',
        '--disable-site-isolation-trials'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Block unnecessary resources to speed up the process
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    socket.emit('update', 'Logging in to Instagram...');
    await page.goto('https://www.instagram.com/accounts/login/');
    await delay(2000);

    await page.type('input[name="username"]', INSTAGRAM_USERNAME as string);
    await page.type('input[name="password"]', INSTAGRAM_PASSWORD as string);
    await page.click('button[type="submit"]');
    await delay(5000); // Increased delay for login

    if (await page.$('input[name="username"]')) {
      throw new Error('Login failed - check your credentials');
    }

    // Handle "Save Your Login Info?" popup
    const saveLoginButton = await page.$('button:has-text("Not Now")');
    if (saveLoginButton) {
      await saveLoginButton.click();
      await delay(1000);
    }

    // Handle "Turn on Notifications" popup
    const notificationButton = await page.$('button:has-text("Not Now")');
    if (notificationButton) {
      await notificationButton.click();
      await delay(1000);
    }

    socket.emit('update', 'Successfully logged in');

    const users = await getUserList(page, username, extractType, maxAccounts);
    if (!users.length) {
      throw new Error(`No ${extractType} found or unable to access list`);
    }

    socket.emit('update', `Found ${users.length} ${extractType} to process`);

    for (const user of users) {
      if (stopProcess) {
        socket.emit('update', 'Process stopped by user');
        break;
      }

      try {
        await page.goto('https://www.instagram.com/direct/new/');
        await delay(2000);

        await page.type('input[placeholder="Search..."]', user);
        await delay(2000);

        const userOption = await page.$(`div:has-text("${user}")`);
        if (!userOption) {
          socket.emit('update', `Could not find user ${user}, skipping...`);
          continue;
        }
        
        await userOption.click();
        await delay(1500);

        const nextButton = await page.$('button:has-text("Next")');
        if (!nextButton) {
          socket.emit('update', `Could not click "Next" for ${user}, skipping...`);
          continue;
        }
        
        await nextButton.click();
        await delay(2000);

        const textArea = await page.$('textarea[placeholder="Message..."]');
        if (!textArea) {
          socket.emit('update', `Could not find message input for ${user}, skipping...`);
          continue;
        }
        
        await textArea.type(message);
        await delay(1500);

        const sendButton = await page.$('button:has-text("Send")');
        if (!sendButton) {
          socket.emit('update', `Could not find send button for ${user}, skipping...`);
          continue;
        }
        
        await sendButton.click();
        processedCount++;

        socket.emit('update', `✓ Message sent to ${user} (${processedCount}/${users.length})`);
        await delay(delayBetweenMsgs * 1000);
      } catch (error: any) {
        socket.emit('update', `× Failed to message ${user}: ${error.message}`);
        await delay(2000);
      }
    }
  } catch (error: any) {
    socket.emit('update', `Error: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
    socket.emit('update', `Process completed. Successfully sent ${processedCount} messages.`);
    stopProcess = false;
  }
}

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('start_process', (data: InstagramAutomation) => {
    stopProcess = false;
    sendMassDM(socket, data);
  });

  socket.on('stop_process', () => {
    stopProcess = true;
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
