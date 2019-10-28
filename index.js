const {Plugin} = require("powercord/entities")
const webpack = require("powercord/webpack")
const {getModuleByDisplayName, getModule} = webpack
const util = require("powercord/util")
const {forceUpdateElement} = util
const {inject, uninject} = require("powercord/injector")

/*
	Use this to control who gets replaced. Will replace if NAME_CONTRAST <= THRESHOLD.
	I think 2 is a nice default.

	0: matches nobody, plugin does nothing
	1: only matches same contrast as background
	2: matches people who are going out of their way to be annoying, but some names might still be hard to read
	3: WCAG AA for 18px text, but default name size is only 16px
	4: names are quite easy to read, but almost all default role colours are reset on both themes
	4.5: meets WCAG AA accessibility standards
	7: meets WCAG AAA accessibility standards
*/
const CONTRAST_EDIT_THRESHOLD = 2
/*
	Want to change it to something better?
	For help with making your choice, here are the contrast ratios for Discord's default role colours.
	Spoiler alert: they're shit.
	The table has the colour name on the left, the colour hex in the middle, and the contrast ratio on the right.

	Ratios with dark theme (#36393f):
	(minimum of group 1 is 2.47, minimum of all is 1.43)
	teal 1:    #1abc9c   4.80
	green 1:   #2ecc71   5.50
	blue 1:    #3498db   3.67
	purple 1:  #9b59b6   2.47
	pink 1:    #e91e63   2.66
	yellow 1:  #f1c40f   6.97
	orange 1:  #e67e22   4.06
	red 1:     #e74c3c   3.03
	grey 1:    #95a5a6   4.52
	cobalt 1:  #607d8b   2.64
	teal 2:    #11806a   2.38
	green 2:   #1f8b4c   2.67
	blue 2:    #206694   1.86
	purple 2:  #71368a   1.43
	pink 2:    #ad1457   1.66
	yellow 2:  #c27c0e   3.40
	orange 2:  #a84300   1.91
	red 2:     #992d22   1.51
	grey 2:    #979c9f   4.17
	cobalt 2:  #546e7a   2.14

	Ratios with light theme (#ffffff):
	(minimum of group 2 is 2.77, minimum of all is 1.66)
	teal 1:    #1abc9c 2.40
	green 1:   #2ecc71 2.10
	blue 1:    #3498db 3.15
	purple 1:  #9b59b6 4.66
	pink 1:    #e91e63 4.34
	yellow 1:  #f1c40f 1.66
	orange 1:  #e67e22 2.84
	red 1:     #e74c3c 3.82
	grey 1:    #95a5a6 2.55
	cobalt 1:  #607d8b 4.37
	teal 2:    #11806a 4.86
	green 2:   #1f8b4c 4.32
	blue 2:    #206694 6.19
	purple 2:  #71368a 8.08
	pink 2:    #ad1457 6.96
	yellow 2:  #c27c0e 3.39
	orange 2:  #a84300 6.05
	red 2:     #992d22 7.62
	grey 2:    #979c9f 2.77
	cobalt 2:  #546e7a 5.40
*/

/*
	I have no idea what these magic numbers mean, but the code works, so shut the fuck up.
	https://stackoverflow.com/a/9733420
	console.log(contrast([255, 255, 255], [255, 255, 0])) // 1.074 for yellow
	console.log(contrast([255, 255, 255], [0, 0, 255])) // 8.592 for blue
*/
function lum(r, g, b) {
	var a = [r, g, b].map(v => {
		v /= 255
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
	})
	return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
}

function getContrast(rgb1, rgb2) {
	const l1 = lum(rgb1[0], rgb1[1], rgb1[2]) + 0.05
	const l2 = lum(rgb2[0], rgb2[1], rgb2[2]) + 0.05
	const result = l1 / l2
	if (result < 1) return 1 / result
	else return result
}

function hexToComponents(hex) {
	if (hex.startsWith("#")) hex = hex.slice(1)
	if (hex.length === 3) hex = [...hex].map(h => h.repeat(2)).join("")
	if (hex.length !== 6) throw new Error("bad hex string")
	const components = Array(3).fill().map((_, i) => parseInt(hex.slice((i*2), (i*2)+2), 16))
	if (components.some(c => c < 0 || c > 255)) throw new Error("bad hex string")
	return components
}

function getTheme(backgroundComponents) {
	const lightContrast = getContrast(backgroundComponents, [255, 255, 255])
	const darkContrast = getContrast(backgroundComponents, hexToComponents("36393f"))
	if (lightContrast < darkContrast) return "light"
	else return "dark"
}

module.exports = class NameContrast extends Plugin {
	constructor() {
		super()
	}

	async startPlugin() {
		this.container = await getModule(["containerCompactBounded"])
		const MessageGroup = await getModuleByDisplayName("MessageGroup")
		const module = await getModule(["parse", "parseTopic"])
		const channels = await getModule(["getChannel"])
		const members = await getModule(["getMember"])

		// Mentions
		await inject("name-contrast-mentions", module, "parse", ([original, , {channelId}], res) => {
			// thanks rolecolor-everywhere, I couldn't have done it without you
			// (though I guess I wouldn't have needed to have done it without you in the first place)
			const background = getComputedStyle(document.querySelector(".chat-3bRxxu")).backgroundColor
			const backgroundComponents = background.match(/\d+/g).map(c => +c)

			const parsed = [...res]
			res.forEach(part => {
				if (typeof part === "string") {
					original = original.slice(part.length)
				} else {
					const originalSplit = original.split(">")
					const mention = originalSplit.shift()
					original = originalSplit.join(">")
					if (part.type.displayName === "DeprecatedPopout" && part.props.children.type && part.props.children.type.displayName === "Mention") {
						const match = mention.match(/(\d+)/)
						if (match) {
							const userId = match[1]
							const guildId = channels.getChannel(channelId).guild_id
							const member = members.getMember(guildId, userId)
							if (member && member.colorString) {
								const style = part.props.children.props.style
								if (style && style["--color"]) { // was actually edited by rce
									/*
										"--color": member.colorString,
										"--hoveredColor": this._numberToTextColor(colorInt),
										"--backgroundColor": this._numberToRgba(colorInt, 0.1)
									*/
									const contrast = getContrast(hexToComponents(style["--color"]), backgroundComponents)
									if (contrast <= CONTRAST_EDIT_THRESHOLD) {
										// console.log(contrast)
										// console.log(hexToComponents(style["--color"]), backgroundComponents)
										// console.log(member)
										if (getTheme(backgroundComponents) === "light") {
											part.props.children.props.style = {
												"--color": "#7289da",
												"--backgroundColor": "#f1f3fb",
												"--hoveredColor": "#ffffff"
											}
										} else {
											part.props.children.props.style = {
												"--color": "#7289da",
												"--backgroundColor": "rgba(114,137,218,.1)",
												"--hoveredColor": "#ffffff"
											}
										}
									}
								}
							}
						}
					}
				}
			})
			return parsed
		})

		// Mentions
		inject("name-contrast-messagegroup", MessageGroup.prototype, "render", function(_, res) {
			const background = getComputedStyle(document.querySelector(".chat-3bRxxu")).backgroundColor
			const backgroundComponents = background.match(/\d+/g).map(c => +c)
			this.props.messages.forEach(message => {
				if (message.oldColorString) message.colorString = message.oldColorString
				if (message.colorString) { // can be null if member has no coloured roles
					// console.log("---===---")
					// console.log(message.author.username)
					// console.log(message.colorString)
					const components = hexToComponents(message.colorString)
					// console.log(backgroundComponents)
					// console.log(components)
					const contrast = getContrast(components, backgroundComponents)
					// console.log(contrast)
					if (contrast <= CONTRAST_EDIT_THRESHOLD) {
						message.oldColorString = message.colorString
						message.colorString = null
					}
				}
			})
			return res
		})
		this.forceUpdate()
	}

	pluginWillUnload() {
		uninject("name-contrast-messagegroup")
		uninject("name-contrast-mentions")
		this.forceUpdate()
	}

	forceUpdate() {
		const containerCompact = this.container.containerCompactBounded.split(" ")[0]
		const containerCozy = this.container.containerCozyBounded.split(" ")[0]
		forceUpdateElement("."+containerCompact, true)
		forceUpdateElement("."+containerCozy, true)
	}
}
