import { render } from 'solid-js/web'
import { App } from './ui/App'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root element')
}

render(() => <App />, rootElement)
