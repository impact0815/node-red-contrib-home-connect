# Home Connect example flows

**English · [Deutsch](README.de.md)**

These examples are designed to be usable without programming knowledge. Start with the built-in simulator: it uses no Home Connect account, no credentials, and no real appliance.

## Before you start

1. Install `@impact0815/node-red-contrib-home-connect`.
2. Restart Node-RED and reload the editor.
3. For the three dashboard examples, also install `@flowfuse/node-red-dashboard`:

   ```bash
   cd ~/.node-red
   npm install @flowfuse/node-red-dashboard
   ```

## Import an included example

1. Open Node-RED.
2. Choose **Menu → Import → Examples → @impact0815/node-red-contrib-home-connect**.
3. Select an example.
4. Click **Import**.
5. Click **Deploy** in the upper-right corner.

Start with **01-first-steps-device-list**. Press the button on the left side of its Inject node. The Debug sidebar should show three simulated appliances.

## Which example should I choose?

| Example | Good for | What to do |
|---|---|---|
| `01-first-steps-device-list.json` | First test | Deploy, press the Inject button, read the appliance list in Debug. |
| `02-events.json` | Live changes | Deploy and watch simulated events in Debug. |
| `03-safe-read-write.json` | Safe writing test | Keep **dry-run** enabled. The flow validates a command but does not send it. |
| `04-local-read-only.json` | Local LAN profiles | Replace the example connection with your own read-only local configuration. It contains no Write node. |
| `dashboard-dishwasher-washer-oven.json` | Full dashboard | Deploy, then open `/dashboard/overview`. It supports cloud and local read-only data. |
| `dashboard-screenshot-simulated.json` | Network-free demo | Deploy and open the dashboard. All appliances and values are simulated. |
| `demo-home-connect-flowfuse-1.34.1-scriptless.json` | Isolated UI demo | Import when you only want to explore the dashboard without Home Connect runtime nodes or network access. |

## Moving from the simulator to your appliances

1. First confirm that the chosen flow works with the simulator.
2. Create either a **Production cloud** connection or a **Local LAN (read-only)** connection.
3. Open every Home Connect node in the imported flow and select your own connection.
4. Click **Done**, then **Deploy**.
5. For cloud access, complete OAuth authorization and use only the permissions you need.
6. Keep cloud Write nodes in **dry-run** until the displayed appliance, command, and values are correct.

Local LAN access is always read-only. A local Write request is rejected before network I/O.

## If nothing appears

- Confirm that Node-RED was restarted after installation.
- Confirm that the flow was deployed.
- Open the Debug sidebar and check whether its filter is hiding messages.
- For dashboards, confirm that `@flowfuse/node-red-dashboard` is installed.
- For cloud flows, test the deployed connection and verify OAuth scopes.
- See the [English troubleshooting guide](../docs/TROUBLESHOOTING.md) or [German troubleshooting guide](../docs/TROUBLESHOOTING.de.md).

## Safety and privacy

Never share Client Secrets, tokens, profile PSK/IV values, real appliance IDs, private addresses, or exported flows containing credentials. Use simulated data and dry-run first. Appliance control can cause heat, motion, and water use.
