import { WebSocketServer, WebSocket } from "ws";
import Hyperswarm from "hyperswarm";
import crypto from "crypto";
import { Duplex } from "stream";

// Configuration types
interface ServerConfig {
  wsPort: number;
  wsPath: string;
  appName: string;
  debug: boolean;
}

// Default configuration
const config: ServerConfig = {
  wsPort: 4080,
  wsPath: "/sync",
  appName: "my-demo-app",
  debug: true,
};

// Logging helper
function log(message: string): void {
  if (config.debug) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }
}

// Create WebSocket server
const wss = new WebSocketServer({
  port: config.wsPort,
  path: config.wsPath,
});

log(
  `WebSocket server running on port ${config.wsPort}, path: ${config.wsPath}`,
);

// Create Hyperswarm connection
const swarm = new Hyperswarm();
const topic: Uint8Array = crypto
  .createHash("sha256")
  .update(config.appName)
  .digest();

log(`P2P network topic: ${Buffer.from(topic).toString("hex").slice(0, 8)}...`);

// Store connections
const wsClients: Set<WebSocket> = new Set();
const p2pConnections: Map<string, Duplex> = new Map();

// Handle WebSocket connections
wss.on("connection", (ws: WebSocket) => {
  log("WebSocket client connected");
  wsClients.add(ws);

  // Forward WebSocket messages to P2P network
  ws.on("message", (data: Buffer) => {
    log("WebSocket message received, forwarding to P2P");

    // Broadcast to other WebSocket clients
    wsClients.forEach((client: WebSocket) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });

    // Forward to P2P
    p2pConnections.forEach((socket: Duplex) => {
      socket.write(data);
    });
  });

  ws.on("close", () => {
    log("WebSocket client disconnected");
    wsClients.delete(ws);
  });

  ws.on("error", (error: Error) => {
    log(`WebSocket error: ${error.message}`);
  });
});

// Handle P2P connections
swarm.on("connection", (socket: Duplex, info: any) => {
  const peerId: string = info.publicKey.toString("hex").slice(0, 8);
  log(`P2P peer connected: ${peerId}...`);

  p2pConnections.set(peerId, socket);

  // Forward P2P messages to WebSocket clients
  socket.on("data", (data: Buffer) => {
    log(`P2P message received from ${peerId}, forwarding to WebSocket`);

    // Forward to WebSocket clients
    wsClients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });

    // Forward to other P2P peers
    p2pConnections.forEach((connection: Duplex, id: string) => {
      if (id !== peerId) {
        connection.write(data);
      }
    });
  });

  socket.on("close", () => {
    log(`P2P peer disconnected: ${peerId}...`);
    p2pConnections.delete(peerId);
  });

  socket.on("error", (error: Error) => {
    log(`P2P connection error with peer ${peerId}: ${error.message}`);
  });
});

// Join the P2P network
swarm.join(topic, {
  lookup: true, // Find other peers
  announce: true, // Announce ourselves
});

// Print connection info
log(`
Bridge server started!
------------------------------------------
WebSocket: ws://localhost:${config.wsPort}${config.wsPath}
P2P Topic: ${Buffer.from(topic).toString("hex")}
App Name: ${config.appName}
------------------------------------------
To make publicly accessible:
1. Install ngrok: npm install -g ngrok
2. Run: ngrok http ${config.wsPort}
`);

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down server...");

  // Close WebSocket server
  wss.close();

  // Leave the swarm
  swarm.leave(topic);

  // Close all P2P connections
  p2pConnections.forEach((socket: Duplex) => {
    socket.destroy();
  });

  log("Server shut down successfully");
  process.exit(0);
});
