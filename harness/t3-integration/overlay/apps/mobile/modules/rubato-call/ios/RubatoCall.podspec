Pod::Spec.new do |s|
  s.name           = 'RubatoCall'
  s.version        = '1.0.0'
  s.summary        = 'Companion calls on the phone: VoIP push and CallKit.'
  s.description    = 'Registers for PushKit VoIP pushes, reports every one to CallKit at once, and tells the app what the person did.'
  s.author         = 'Rubato'
  s.homepage       = 'https://github.com/keepitmello/Rubato'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CallKit', 'PushKit', 'AVFAudio'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift}'
end
