// GitHub's answers to the device flow, as its endpoints send them: the bodies of `POST github.com/login/device/code`
// and of each `POST github.com/login/oauth/access_token` poll, all with status 200. The device code, pending,
// slow_down and expired answers were recorded from github.com with Path of Dev's client id on 2026-10-14, the codes
// swapped for GitHub's documented examples. A denial and a token need a person at the other end, so those two are
// GitHub's documented bodies, in the recorded answers' form.

export const github = {
  deviceCode:
    '{"device_code":"3584d83530557fdd1f46af8289938c8ef79f9dc5","user_code":"WDJB-MJHT",' +
    '"verification_uri":"https://github.com/login/device","expires_in":899,"interval":5}',
  pending:
    '{"error":"authorization_pending","error_description":"The authorization request is still pending.",' +
    '"error_uri":"https://docs.github.com/developers/apps/authorizing-oauth-apps#error-codes-for-the-device-flow"}',
  slowDown:
    '{"error":"slow_down","error_description":"Too many requests have been made in the same timeframe.",' +
    '"error_uri":"https://docs.github.com","interval":10}',
  expired:
    '{"error":"expired_token","error_description":"This \'device_code\' has expired.",' +
    '"error_uri":"https://docs.github.com/developers/apps/authorizing-oauth-apps#error-codes-for-the-device-flow"}',
  denied:
    '{"error":"access_denied","error_description":"The authorization request was denied.",' +
    '"error_uri":"https://docs.github.com/developers/apps/authorizing-oauth-apps#error-codes-for-the-device-flow"}',
  success: '{"access_token":"gho_16C7e42F292c6912E7710c838347Ae178B4a","token_type":"bearer","scope":""}',
} as const
