<template>
    <Login />
</template>

<script>

import Login from '~/components/pages/Login'

export default {
    head() {
        return {
            title: "Terms & Conditions | Housinginteractive.com.ph"
        }
    },
    layout: 'empty',
    components : { Login }

}

</script>