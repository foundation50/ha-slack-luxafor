# Slack Luxafor

A Home Assistant app repository that turns a Luxafor Signal into a Slack activity indicator.

## Behavior

Messages in the configured Slack channel light the Signal yellow. Mentioning a configured Slack user lights it red. Red takes precedence; when it expires, yellow resumes if it is still active. Each new event resets its relevant timer.

## Configuration

```yaml
slack_app_token: xapp-...
slack_channel_id: C0123456789
slack_mention_user_ids: U0123456789,U0987654321
luxafor_url: http://10.6.114.189
luxafor_token: your-device-token
yellow_duration_seconds: 30
red_duration_seconds: 30
```

Use Slack IDs, not names. Leave `slack_mention_user_ids` empty to never show red.

## Slack Setup

Enable Socket Mode and create an app-level token with `connections:write`. In Event Subscriptions, add `message.channels` under bot events, install the app to the workspace, and invite the bot to the configured public channel. Use `message.groups` for a private channel.

## Luxafor Setup

The Signal must be reachable from Home Assistant and accept authenticated `POST /at` commands. The app sends `AT+SC=4095,FFFF00`, `AT+SC=4095,FF0000`, and `AT+SC=4095,000000` for yellow, red, and off respectively.

## Development

```sh
cd slack-luxafor
npm ci
npm run check
npm run build
```
