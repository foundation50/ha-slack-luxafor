import { readFile } from "node:fs/promises"
import { SocketModeClient } from "@slack/socket-mode"

const OPTIONS_PATH = "/data/options.json"
const ALL_LEDS = "4095"
const YELLOW = "FFFF00"
const RED = "FF0000"
const OFF = "000000"

type LightMode = "yellow" | "red" | "off"

interface Options {
  slack_app_token: string
  slack_channel_id: string
  slack_mention_user_ids: string
  luxafor_url: string
  luxafor_token: string
  yellow_duration_seconds: number
  red_duration_seconds: number
}

class LuxaforClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  public async setMode(mode: LightMode): Promise<void> {
    const color = mode === "yellow" ? YELLOW : mode === "red" ? RED : OFF
    const response = await fetch(`${this.baseUrl}/at`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: `AT+SC=${ALL_LEDS},${color}` }),
    })

    if (!response.ok) {
      throw new Error(
        `Luxafor request failed with ${response.status}: ${await response.text()}`,
      )
    }
  }
}

class NotificationController {
  private yellowUntil = 0
  private redUntil = 0
  private mode: LightMode | undefined
  private timer: NodeJS.Timeout | undefined
  private pending = Promise.resolve()

  public constructor(
    private readonly luxafor: LuxaforClient,
    private readonly yellowDurationMs: number,
    private readonly redDurationMs: number,
  ) {}

  public async start(): Promise<void> {
    await this.sync()
  }

  public notify(isMention: boolean): void {
    const now = Date.now()
    this.yellowUntil = Math.max(this.yellowUntil, now + this.yellowDurationMs)

    if (isMention) {
      this.redUntil = Math.max(this.redUntil, now + this.redDurationMs)
    }

    void this.sync().catch((error) => {
      console.error("Could not update Luxafor notification", error)
    })
  }

  public async stop(): Promise<void> {
    this.yellowUntil = 0
    this.redUntil = 0

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    await this.sync()
  }

  private sync(): Promise<void> {
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        const now = Date.now()
        const nextMode = this.getMode(now)

        try {
          if (nextMode !== this.mode) {
            await this.luxafor.setMode(nextMode)
            this.mode = nextMode
            console.log(`Luxafor mode: ${nextMode}`)
          }
        } finally {
          this.scheduleNextUpdate(now)
        }
      })

    return this.pending
  }

  private getMode(now: number): LightMode {
    if (now < this.redUntil) {
      return "red"
    }

    if (now < this.yellowUntil) {
      return "yellow"
    }

    return "off"
  }

  private scheduleNextUpdate(now: number): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    const deadline =
      now < this.redUntil
        ? this.redUntil
        : now < this.yellowUntil
          ? this.yellowUntil
          : undefined

    if (!deadline) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sync().catch((error) => {
        console.error("Could not update Luxafor notification", error)
      })
    }, Math.max(0, deadline - Date.now()))
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is missing or empty`)
  }

  return value.trim()
}

function duration(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }

  return value
}

async function readOptions(): Promise<Options> {
  const value = JSON.parse(await readFile(OPTIONS_PATH, "utf8")) as Record<
    string,
    unknown
  >

  const appToken = requiredString(value.slack_app_token, "slack_app_token")
  const channelId = requiredString(value.slack_channel_id, "slack_channel_id")
  const luxaforUrl = requiredString(value.luxafor_url, "luxafor_url").replace(
    /\/$/,
    "",
  )

  if (!appToken.startsWith("xapp-")) {
    throw new Error("slack_app_token does not look like an App-Level Token")
  }

  try {
    new URL(luxaforUrl)
  } catch {
    throw new Error("luxafor_url must be a valid URL")
  }

  return {
    slack_app_token: appToken,
    slack_channel_id: channelId,
    slack_mention_user_ids:
      typeof value.slack_mention_user_ids === "string"
        ? value.slack_mention_user_ids
        : "",
    luxafor_url: luxaforUrl,
    luxafor_token: requiredString(value.luxafor_token, "luxafor_token"),
    yellow_duration_seconds: duration(
      value.yellow_duration_seconds,
      "yellow_duration_seconds",
    ),
    red_duration_seconds: duration(
      value.red_duration_seconds,
      "red_duration_seconds",
    ),
  }
}

async function main(): Promise<void> {
  const options = await readOptions()
  const mentionIds = new Set(
    options.slack_mention_user_ids
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )
  const controller = new NotificationController(
    new LuxaforClient(options.luxafor_url, options.luxafor_token),
    options.yellow_duration_seconds * 1_000,
    options.red_duration_seconds * 1_000,
  )
  const slack = new SocketModeClient({ appToken: options.slack_app_token })

  slack.on("message", ({ event, ack }) => {
    void ack()

    if (event.channel !== options.slack_channel_id || !event.text) {
      return
    }

    const isMention = [...mentionIds].some((userId) =>
      event.text.includes(`<@${userId}>`),
    )

    controller.notify(isMention)
  })

  slack.on("error", (error) => {
    console.error("Slack Socket Mode error", error)
  })

  await controller.start()
  await slack.start()

  console.log("Slack Socket Mode connected; Luxafor notifications are active")

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`Received ${signal}; turning off Luxafor`)
    void controller.stop().finally(() => process.exit(0))
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  await new Promise<void>(() => undefined)
}

main().catch((error) => {
  console.error("Fatal error", error)
  process.exitCode = 1
})
